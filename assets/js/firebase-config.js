// ============================================================
//  Firebase Configuration
//  Replace the placeholder values below with your actual
//  Firebase project credentials from:
//  https://console.firebase.google.com → Project Settings → General → Your apps
// ============================================================
const firebaseConfig = {
    apiKey:            "AIzaSyBh6b36eTraHCCdSeSzSCX4lbGUCFfT9iA",
    authDomain:        "codecollab-3ac41.firebaseapp.com",
    databaseURL:       "https://codecollab-3ac41-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId:         "codecollab-3ac41",
    storageBucket:     "codecollab-3ac41.firebasestorage.app",
    messagingSenderId: "258237744050",
    appId:             "1:258237744050:web:c1374d511cb1d323549aab",
    measurementId:     "G-CD0DZT0RQ6"
};

firebase.initializeApp(firebaseConfig);
const db   = firebase.database();
const auth = firebase.auth();
