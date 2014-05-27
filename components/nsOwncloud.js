/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* This file implements the nsIMsgCloudFileProvider interface.
 *
 * This component handles the Owncloud implementation of the
 * nsIMsgCloudFileProvider interface.
 */

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource:///modules/oauth.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/gloda/log4moz.js");
Cu.import("resource:///modules/cloudFileAccounts.js");

const kRestBase = "/ocs/v1.php"
const kAuthPath = kRestBase + "/person/check";
const kShareApp = kRestBase + "/apps/files_sharing/api/v1/shares";
// According to Dropbox, the kMaxFileSize is a fixed limit.
const kMaxFileSize = 157286400;
const kWebDavPath = "/remote.php/webdav";

function wwwFormUrlEncode(aStr) {
  return encodeURIComponent(aStr).replace(/!/g, '%21')
                                 .replace(/'/g, '%27')
                                 .replace(/\(/g, '%28')
                                 .replace(/\)/g, '%29')
                                 .replace(/\*/g, '%2A');
}


function nsOwncloud() {
  this.log = Log4Moz.getConfiguredLogger("Owncloud");
}

nsOwncloud.prototype = {
  /* nsISupports */
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIMsgCloudFileProvider]),

  classID: Components.ID("{ad8c3b77-7dc8-41d1-8985-5be88b254ff3}"),

  get type() "Owncloud",
  get displayName() "ownCloud",
  get serviceURL() this._serverUrl,
  get iconClass() "chrome://owncloud/content/owncloud.png",
  get accountKey() this._accountKey,
  get lastError() this._lastErrorText,
  get settingsURL() "chrome://owncloud/content/settings.xhtml",
  get managementURL() "chrome://owncloud/content/management.xhtml",

  _accountKey: false,
  _serverUrl: "",
  _storageFolder: "",
  _userName: "",
  _password: "",
  _prefBranch: null,
  _loggedIn: false,
  _authToken: "",
  _userInfo: null,
  _file : null,
  _requestDate: null,
  _successCallback: null,
  _connection: null,
  _request: null,
  _uploadingFile : null,
  _uploader : null,
  _lastErrorStatus : 0,
  _lastErrorText : "",
  _maxFileSize : kMaxFileSize,
  _totalStorage: -1,
  _fileSpaceUsed : -1,
  _uploads: [],
  _urlsForFiles : {},
  _uploadInfo : {}, // upload info keyed on aFiles.

  /**
   * Initialize this instance of nsOwncloud, setting the accountKey.
   *
   * @param aAccountKey the account key to initialize this provider with
   */
  init: function nsOwncloud_init(aAccountKey) {
    this._accountKey = aAccountKey;
    this._prefBranch = Services.prefs.getBranch("mail.cloud_files.accounts." + 
                                                aAccountKey + ".");
    this._serverUrl = this._prefBranch.getCharPref("server");
    this._storageFolder = this._prefBranch.getCharPref("storageFolder");
    this._userName = this._prefBranch.getCharPref("username");
    this._password = this._prefBranch.getCharPref("password");
  },

  /**
   * The callback passed to an nsOwncloudFileUploader, which is fired when
   * nsOwncloudFileUploader exits.
   *
   * @param aRequestObserver the request observer originally passed to
   *                         uploadFile for the file associated with the
   *                         nsOwncloudFileUploader
   * @param aStatus the result of the upload
   */
  _uploaderCallback : function nsOwncloud__uploaderCallback(aRequestObserver,
                                                           aStatus) {
    aRequestObserver.onStopRequest(null, null, aStatus);
    this._uploadingFile = null;
    this._uploads.shift();
    if (this._uploads.length > 0) {
      let nextUpload = this._uploads[0];
      this.log.info("chaining upload, file = " + nextUpload.file.leafName);
      this._uploadingFile = nextUpload.file;
      this._uploader = nextUpload;
      try {
        this.uploadFile(nextUpload.file, nextUpload.callback);
      }
      catch (ex) {
        nextUpload.callback(nextUpload.requestObserver, Cr.NS_ERROR_FAILURE);
      }
    }
    else
      this._uploader = null;
  },

  /** 
   * Attempts to upload a file to Owncloud.
   *
   * @param aFile the nsILocalFile to be uploaded
   * @param aCallback an nsIRequestObserver for listening for the starting
   *                  and ending states of the upload.
   */
  uploadFile: function nsOwncloud_uploadFile(aFile, aCallback) {
    if (Services.io.offline)
      throw Ci.nsIMsgCloudFileProvider.offlineErr;

    this.log.info("uploading " + aFile.leafName);

    // Some ugliness here - we stash requestObserver here, because we might
    // use it again in _getUserInfo.
    this.requestObserver = aCallback;

    // if we're uploading a file, queue this request.
    if (this._uploadingFile && this._uploadingFile != aFile) {
      let uploader = new nsOwncloudFileUploader(this, aFile,
                                               this._uploaderCallback
                                                   .bind(this),
                                               aCallback);
      this._uploads.push(uploader);
      return;
    }
    this._file = aFile;
    this._uploadingFile = aFile;

    let successCallback = this._finishUpload.bind(this, aFile, aCallback);
    if (!this._loggedIn)
      return this._logonAndGetUserInfo(successCallback, null, true);
    this.log.info("getting user info");
    if (!this._userInfo)
      return this._getUserInfo(successCallback);
    successCallback();
  },

  /**
   * A private function used to ensure that we can actually upload the file
   * (we haven't exceeded file size or quota limitations), and then attempts
   * to kick-off the upload.
   *
   * @param aFile the nsILocalFile to upload
   * @param aCallback an nsIRequestObserver for monitoring the starting and
   *                  ending states of the upload.
   */
  _finishUpload: function nsOwncloud__finishUpload(aFile, aCallback) {
    let exceedsFileLimit = Ci.nsIMsgCloudFileProvider.uploadExceedsFileLimit;
    let exceedsQuota = Ci.nsIMsgCloudFileProvider.uploadWouldExceedQuota;
    if (aFile.fileSize > this._maxFileSize)
      return aCallback.onStopRequest(null, null, exceedsFileLimit);
    if (aFile.fileSize > this.remainingFileSpace)
      return aCallback.onStopRequest(null, null, exceedsQuota);

    delete this._userInfo; // force us to update userInfo on every upload.

    if (!this._uploader) {
      this._uploader = new nsOwncloudFileUploader(this, aFile,
                                                 this._uploaderCallback
                                                     .bind(this),
                                                 aCallback);
      this._uploads.unshift(this._uploader);
    }

    this._uploadingFile = aFile;
    this._uploader.uploadFile();
  },

  /**
   * Attempts to cancel a file upload.
   *
   * @param aFile the nsILocalFile to cancel the upload for.
   */
  cancelFileUpload: function nsOwncloud_cancelFileUpload(aFile) {
    if (this._uploadingFile.equals(aFile)) {
      this._uploader.cancel();
    }
    else {
      for (let i = 0; i < this._uploads.length; i++)
        if (this._uploads[i].file.equals(aFile)) {
          this._uploads[i].requestObserver.onStopRequest(
            null, null, Ci.nsIMsgCloudFileProvider.uploadCanceled);
          this._uploads.splice(i, 1);
          return;
        }
    }
  },

  /**
   * A private function used to retrieve the profile information for the
   * user account associated with the accountKey.
   *
   * @param successCallback the function called if information retrieval
   *                        is successful
   * @param failureCallback the function called if information retrieval fails
   */
  _getUserInfo: function nsOwncloud__getUserInfo(successCallback,
                                                failureCallback) {
    if (!successCallback)
      successCallback = function() {
        this.requestObserver
            .onStopRequest(null, null,
                           this._loggedIn ? Cr.NS_OK : Ci.nsIMsgCloudFileProvider.authErr);
      }.bind(this);

    if (!failureCallback)
      failureCallback = function () {
        this.requestObserver
            .onStopRequest(null, null, Ci.nsIMsgCloudFileProvider.authErr);
      }.bind(this);
      
    let body = '<propfind xmlns="DAV:">' +
                 '<prop>' +
                   '<quota-available-bytes/>' +
                   '<quota-used-bytes/>' +
                 '</prop>' +
               '</propfind>';
      
    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);

    req.open("PROPFIND", this._serverUrl + kWebDavPath, true, this._userName, this._password);
    req.onerror = function() {
      this.log.info("logon failure");
      failureCallback();
    }.bind(this);

    req.onload = function() {
      if (req.status >= 200 && req.status < 400) {
        let availBytes = req.responseXML.documentElement.getElementsByTagNameNS("DAV:", "quota-available-bytes");

        let qub = req.responseXML.documentElement.getElementsByTagNameNS("DAV:", "quota-used-bytes");
        this._fileSpaceUsed = qub && qub.length && qub[0].textContent || -1;
        if (this._fileSpaceUsed < 0) this._fileSpaceUsed = -1;

        let qab = req.responseXML.documentElement.getElementsByTagNameNS("DAV:", "quota-available-bytes");
        let fsa = qab && qab.length && qab[0].textContent;
        if (fsa && fsa > -1) {
          this._totalStorage = fsa;
        } else if (!fsa && fsa !== 0) {
          this._totalStorage = -1;
        } else if (!fsa || fsa < 0) {
          this._totalStorage = 0;
        }
        successCallback();
      }
      else {
        failureCallback();
      }
    }.bind(this);
    
    req.send(body);
  },

  /**
   * A private function that first ensures that the user is logged in, and then
   * retrieves the user's profile information.
   *
   * @param aSuccessCallback the function called on successful information
   *                         retrieval
   * @param aFailureCallback the function called on failed information retrieval
   * @param aWithUI a boolean for whether or not we should display authorization
   *                UI if we don't have a valid token anymore, or just fail out.
   */
  _logonAndGetUserInfo: function nsOwncloud_logonAndGetUserInfo(aSuccessCallback,
                                                               aFailureCallback,
                                                               aWithUI) {
    if (!aFailureCallback)
      aFailureCallback = function () {
        this.requestObserver
            .onStopRequest(null, null, Ci.nsIMsgCloudFileProvider.authErr);
      }.bind(this);

    return this.logon(function() {
      this._getUserInfo(aSuccessCallback, aFailureCallback);
    }.bind(this), aFailureCallback, aWithUI);
  },

  /**
   * For some nsILocalFile, return the associated sharing URL.
   *
   * @param aFile the nsILocalFile to retrieve the URL for
   */
  urlForFile: function nsOwncloud_urlForFile(aFile) {
    return this._urlsForFiles[aFile.path];
  },

  /**
   * Updates the profile information for the account associated with the
   * account key.
   *
   * @param aWithUI a boolean for whether or not we should display authorization
   *                UI if we don't have a valid token anymore, or just fail out.
   * @param aCallback an nsIRequestObserver for observing the starting and
   *                  ending states of the request.
   */
  refreshUserInfo: function nsOwncloud_refreshUserInfo(aWithUI, aCallback) {
    if (Services.io.offline)
      throw Ci.nsIMsgCloudFileProvider.offlineErr;
    this.requestObserver = aCallback;
    aCallback.onStartRequest(null, null);
    if (!this._loggedIn)
      return this._logonAndGetUserInfo(null, null, aWithUI);
    if (!this._userInfo)
      return this._getUserInfo();
    return this._userInfo;
  },


  /**
   * Our Owncloud implementation does not implement the createNewAccount
   * function defined in nsIMsgCloudFileProvider.idl.
   */
  createNewAccount: function nsOwncloud_createNewAccount(aEmailAddress,
                                                        aPassword, aFirstName,
                                                        aLastName) {
    return Cr.NS_ERROR_NOT_IMPLEMENTED;
  },

  /**
   * If the user already has an account, we can get the user to just login
   * to it via OAuth.
   *
   * This function does not appear to be called from the BigFiles UI, and
   * might be excisable.
   */
  createExistingAccount: function nsOwncloud_createExistingAccount(aRequestObserver) {
     // XXX: replace this with a better function
    let successCb = function(aResponseText, aRequest) {
      aRequestObserver.onStopRequest(null, this, Cr.NS_OK);
    }.bind(this);

    let failureCb = function(aResponseText, aRequest) {
      aRequestObserver.onStopRequest(null, this,
                                     Ci.nsIMsgCloudFileProvider.authErr);
    }.bind(this);

    this.logon(successCb, failureCb, true);
  },

  /**
   * If the provider doesn't have an API for creating an account, perhaps
   * there's a url we can load in a content tab that will allow the user
   * to create an account.
   */
  get createNewAccountUrl() "",

  /**
   * For a particular error, return a URL if Owncloud has a page for handling
   * that particular error.
   *
   * @param aError the error to get the URL for
   */
  providerUrlForError: function nsOwncloud_providerUrlForError(aError) {
    return "";
  },

  /**
   * If we don't know the limit, this will return -1.
   */
  get fileUploadSizeLimit() this._maxFileSize,
  get remainingFileSpace() this._totalStorage - this._fileSpaceUsed,
  get fileSpaceUsed() this._fileSpaceUsed,

  /**
   * Attempt to delete an upload file if we've uploaded it.
   *
   * @param aFile the file that was originall uploaded
   * @param aCallback an nsIRequestObserver for monitoring the starting and
   *                  ending states of the deletion request.
   */
  deleteFile: function nsOwncloud_deleteFile(aFile, aCallback) {
    return Cr.NS_ERROR_NOT_IMPLEMENTED;
  },

  /**
   * This function is used by our testing framework to override the default
   * URL's that nsOwncloud connects to.
   */
  overrideUrls : function nsOwncloud_overrideUrls(aNumUrls, aUrls) {
    this._serverUrl = aUrls[0];
  },

  /**
   * logon to the owncloud account.
   *
   * @param successCallback - called if logon is successful
   * @param failureCallback - called back on error.
   * @param aWithUI if false, logon fails if it would have needed to put up UI.
   *                This is used for things like displaying account settings,
   *                where we don't want to pop up the oauth ui.
   */
  logon: function nsOwncloud_logon(successCallback, failureCallback, aWithUI) {
    this.log.info("Logging in, aWithUI = " + aWithUI);
    if (this._password == undefined || !this._password)
      this._password = this.getPassword(this._userName, !aWithUI);
    this.log.info("Sending login information...");

    let loginData = "login=" + wwwFormUrlEncode(this._userName) + "&password=" +
                                                wwwFormUrlEncode(this._password);
    let args = "?format=json";
    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);

    req.open("POST", this._serverUrl + kAuthPath + args, true);
    req.setRequestHeader('Content-Type', "application/x-www-form-urlencoded");
    
    req.onerror = function() {
      this.log.info("logon failure");
      failureCallback();
    }.bind(this);

    req.onload = function() {
      if (req.status >= 200 && req.status < 400) {
        try {
          this.log.info("auth token response = " + req.responseText);
          let docResponse = JSON.parse(req.responseText);
          //this.log.info("login response parsed = " + docResponse);
          let statuscode = docResponse.ocs.meta.statuscode;
          this.log.info("statuscode = " + statuscode);
          if (statuscode == 100) {
            this._loggedIn = true;
            successCallback();
          }
          else {
            this._loggedIn = false;
            this._lastErrorText = docResponse.ocs.meta.message;
            this._lastErrorStatus = docResponse.ocs.meta.statuscode;
            failureCallback();
          }
        } catch(e) {
          this.log.error(e);
          this._loggedIn = false;
          failureCallback();
        }
      }
      else {
        failureCallback();
      }
    }.bind(this);
    
    req.send(loginData);
    this.log.info("Login information sent!");
  },
};

function nsOwncloudFileUploader(aOwncloud, aFile, aCallback, aRequestObserver) {
  this.owncloud = aOwncloud;
  this.log = this.owncloud.log;
  this.log.info("new nsOwncloudFileUploader file = " + aFile.leafName);
  this.file = aFile;
  this.callback = aCallback;
  this.requestObserver = aRequestObserver;
}

nsOwncloudFileUploader.prototype = {
  owncloud : null,
  file : null,
  callback : null,
  request : null,
  _fileUploadTS: { }, // timestamps to prepend, avoiding filename conflict

  /**
   * Kicks off the upload request for the file associated with this Uploader.
   */
  uploadFile: function nsOFU_uploadFile() {
    this.requestObserver.onStartRequest(null, null);
    this._fileUploadTS[this.file.path] = new Date().getTime();
    this.log.info("ready to upload file " + wwwFormUrlEncode(this.file.leafName) + " to folder " + this.owncloud._storageFolder);
    let url = this.owncloud._serverUrl + kWebDavPath + "/" + this.owncloud._storageFolder + "/"
        + this._fileUploadTS[this.file.path] + "_" + this.file.leafName;
    let fileContents = "";
    let fstream = Cc["@mozilla.org/network/file-input-stream;1"]
                     .createInstance(Ci.nsIFileInputStream);
    fstream.init(this.file, -1, 0, 0);

    let bufStream = Cc["@mozilla.org/network/buffered-input-stream;1"].
      createInstance(Ci.nsIBufferedInputStream);
    bufStream.init(fstream, this.file.fileSize);
    bufStream = bufStream.QueryInterface(Ci.nsIInputStream);
    let contentLength = fstream.available();
    
    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);

    req.open("PUT", url, true, this._userName, this._password);
    req.onerror = function() {
      this.log.info("Could not upload file");
      if (this.callback) {
          this.callback(this.requestObserver,
                        Ci.nsIMsgCloudFileProvider.uploadErr);
      }
    }.bind(this);

    req.onload = function() {
      if (req.status >= 200 && req.status < 400) {
        this._getShareUrl(this.file, this.callback);
      }
      else {
        if (this.callback)
          this.callback(this.requestObserver,
                        Ci.nsIMsgCloudFileProvider.uploadErr);
      }
    }.bind(this);
    req.setRequestHeader("Content-Length", contentLength);
    req.send(bufStream);
  },

  /**
   * Cancels the upload request for the file associated with this Uploader.
   */
  cancel: function nsOFU_cancel() {
    this.callback(this.requestObserver, Ci.nsIMsgCloudFileProvider.uploadCanceled);
    if (this.request) {
      let req = this.request;
      if (req.channel) {
        this.log.info("canceling channel upload");
        delete this.callback;
        req.channel.cancel(Cr.NS_BINDING_ABORTED);
      }
      this.request = null;
    }
  },

  /**
   * Private function that attempts to retrieve the sharing URL for the file
   * uploaded with this Uploader.
   *
   * @param aFile ...
   * @param aCallback an nsIRequestObserver for monitoring the starting and
   *                  ending states of the URL retrieval request.
   */
  _getShareUrl: function nsOFU__getShareUrl(aFile, aCallback) {
    //let url = this.owncloud._serverUrl + kWebDavPath;
    this.file = aFile;

    let formData  = "shareType=3&path=" + wwwFormUrlEncode("/" + this.owncloud._storageFolder + "/"
        + this._fileUploadTS[this.file.path] + "_" + this.file.leafName);
    let args = "?format=json";
    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
    
    req.open("POST", this.owncloud._serverUrl + kShareApp + args, true,
        this.owncloud._userName, this.owncloud._password);
    req.withCredentials = true;
    req.setRequestHeader('Content-Type', "application/x-www-form-urlencoded");
    req.setRequestHeader("Content-Length", formData.length);
    
    req.onload = function() {
      this.log.debug("Raw response: " + req.responseText);
      if (req.status >= 200 && req.status < 400) {
        try {
          var response = JSON.parse(req.responseText);
          this.owncloud._urlsForFiles[this.file.path] = response.ocs.data.url 
                                                        + '&download';
          aCallback(this.requestObserver, Cr.NS_OK);
        } catch(e) {
            this.log.error(e);
            aCallback(this.requestObserver, Ci.nsIMsgCloudFileProvider.uploadErr);
        }
      } else {
        this.log.info("Could not retrive share URL");
        aCallback(this.requestObserver, Cr.NS_ERROR_FAILURE);
      }
    }.bind(this);

    req.onerror = function(e) {
      this.log.debug("Other error: " + e);
      aCallback(this.requestObserver, Cr.NS_ERROR_FAILURE);
    }.bind(this);
    this.log.debug("Raw formData: " + formData);
    req.send(formData);
  },
};

const NSGetFactory = XPCOMUtils.generateNSGetFactory([nsOwncloud]);
