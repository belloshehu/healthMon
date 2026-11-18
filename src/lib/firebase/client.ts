import { initializeApp, getApps, getApp, FirebaseApp } from "firebase/app";
import { getAuth, connectAuthEmulator, Auth } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, Firestore } from "firebase/firestore";
import { getDatabase, connectDatabaseEmulator, Database } from "firebase/database";

const firebaseConfig = {
  apiKey:
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||
    "AIzaSyCyANuP3SgrjeAgl_GYf2tgMJYgo1ZVVZ8",
  authDomain:
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ||
    "safecrowdai-f5d43.firebaseapp.com",
  projectId:
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "safecrowdai-f5d43",
  databaseURL:
    process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL ||
    "https://safecrowdai-f5d43-default-rtdb.firebaseio.com",
  storageBucket:
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ||
    "safecrowdai-f5d43.firebasestorage.app",
  messagingSenderId:
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "731486558480",
  appId:
    process.env.NEXT_PUBLIC_FIREBASE_APP_ID ||
    "1:123456789012:web:abcdef1234567890",
};

let app: FirebaseApp;
let auth: Auth;
let db: Firestore;
let rtdb: Database;
let emulatorsConnected = false;

export function getFirebaseClient(): {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  rtdb: Database;
} {
  if (!getApps().length) {
    app = initializeApp(firebaseConfig);
  } else {
    app = getApp();
  }

  auth = getAuth(app);
  db = getFirestore(app);
  rtdb = getDatabase(app);

  if (
    typeof window !== "undefined" &&
    process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === "true" &&
    !emulatorsConnected
  ) {
    connectAuthEmulator(auth, "http://localhost:9099", {
      disableWarnings: true,
    });
    connectFirestoreEmulator(db, "localhost", 8080);
    connectDatabaseEmulator(rtdb, "localhost", 9000);
    emulatorsConnected = true;
  }

  return { app, auth, db, rtdb };
}
