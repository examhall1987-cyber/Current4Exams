// ─────────────────────────────────────────────
//  REPLACE these values with your Firebase project config
//  Firebase Console → Project Settings → Your apps → SDK setup
// ─────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId:             "YOUR_APP_ID"
};

// Admin password (change this to something strong)
const ADMIN_PASSWORD = "admin@statepcs2025";

export { firebaseConfig, ADMIN_PASSWORD };
