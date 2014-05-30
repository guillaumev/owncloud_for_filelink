# Owncloud for Filelink
Development: GVJ Web Sites & Consulting - http://www.viguierjust.com

## Description
Owncloud for Filelink makes it easy to send large attachments by uploading those attachments to any Owncloud server and inserting a link to the file into the body of your email.

Owncloud is a popular storage service, and this add-on allows Filelink to make use of it.

## Installation
1a) Download the provided .xpi release
OR
1b) Zip all files from this repository such that the install.rdf and chrome.manifest are located in the root folder of the zip file. Change the file extension from .zip to .xpi.
2) Open your Thunderbird, navigate to Tools->Add-Ons, choose "Install Add-On From File..." and select the .xpi file. After installation restart your thunderbird.
3) Navigate to Edit->Preferences->Attachments and add an online storage on the outgoing tab. Select ownCloud from the list and type in your ownCloud url/credentials. If you want to save the attachments not in the root folder of your ownCloud account, then you have to modify the storage path, e.g. use "/mail_attachments/" if you want to save all attachments in the folder named mail_attachments.
4) After setting up the account Thunderbird will ask you if you want to upload big mail attachments to ownCloud.

## Requirements
ownCloud: 5.0.13 and newer
Thunderbird: 13.0 and newer
