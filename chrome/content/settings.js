function extraArgs() {
  var serverValue = document.getElementById("server").value;
  var storageFolderValue = document.getElementById("storageFolder").value;
  var userValue = document.getElementById("username").value;
  var protectUploadsValue = document.getElementById("protectUploads").value;
  return {
    "server": {type: "char", value: serverValue},
    "storageFolder": {type: "char", value: storageFolderValue},
    "username": {type: "char", value: userValue},
    "protectUploads": {type: "char", value: protectUploadsValue},
  };
}
