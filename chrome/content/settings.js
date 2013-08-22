function extraArgs() {
  var serverValue = document.getElementById("server").value;
  var userValue = document.getElementById("username").value;
  var passValue = document.getElementById("password").value;
  return {
    "server": {type: "char", value: serverValue},
    "username": {type: "char", value: userValue},
    "password": {type: "char", value: passValue},
  };
}
