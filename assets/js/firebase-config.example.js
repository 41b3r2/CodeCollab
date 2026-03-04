// ============================================================
//  Firebase Configuration — EXAMPLE TEMPLATE
//  1. Copy this file:  firebase-config.example.js → firebase-config.js
//  2. Replace every YOUR_* placeholder with your real values from:
//     https://console.firebase.google.com → Project Settings → General → Your apps
//  3. firebase-config.js is listed in .gitignore and will NOT be committed.
// ============================================================
const firebaseConfig = {
    apiKey:            "YOUR_API_KEY",
    authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
    databaseURL:       "https://YOUR_PROJECT_ID-default-rtdb.YOUR_REGION.firebasedatabase.app",
    projectId:         "YOUR_PROJECT_ID",
    storageBucket:     "YOUR_PROJECT_ID.firebasestorage.app",
    messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
    appId:             "YOUR_APP_ID",
    measurementId:     "YOUR_MEASUREMENT_ID"
};

firebase.initializeApp(firebaseConfig);
const db   = firebase.database();
const auth = firebase.auth();
