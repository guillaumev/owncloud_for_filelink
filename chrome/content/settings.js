function extraArgs() {
  var serverValue = document.getElementById("server").value;
  var storageFolderValue = document.getElementById("storageFolder").value;
  var userValue = document.getElementById("username").value;
  var passValue = document.getElementById("password").value;
  return {
    "server": {type: "char", value: serverValue},
    "storageFolder": {type: "char", value: storageFolderValue},
    "username": {type: "char", value: userValue},
    "password": {type: "char", value: passValue},
  };
}
