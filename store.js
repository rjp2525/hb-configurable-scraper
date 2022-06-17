"use strict";

const firebase = require("firebase-admin"),
  credentials = require("./key.json");

const timestamp = () => {
  return firebase.firestore.Timestamp.now();
};

firebase.initializeApp({
  credential: firebase.credential.cert(credentials),
});

module.exports = { firebase, timestamp };
