import { initializeApp, getApps, getApp, FirebaseApp } from "firebase/app";
import { getAuth, connectAuthEmulator, Auth } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, Firestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey:
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||
    "AIzaSyDummyKeyForLocalDevelopment12345",
  authDomain:
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ||
    "healthos-ng-iot.firebaseapp.com",
  projectId:
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "healthos-ng-iot",
  storageBucket:
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ||
    "healthos-ng-iot.appspot.com",
  messagingSenderId:
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "123456789012",
  appId:
    process.env.NEXT_PUBLIC_FIREBASE_APP_ID ||
    "1:123456789012:web:abcdef1234567890",
};

let app: FirebaseApp;
let auth: Auth;
let db: Firestore;
let emulatorsConnected = false;

export function getFirebaseClient(): {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
} {
  if (!getApps().length) {
    app = initializeApp(firebaseConfig);
  } else {
    app = getApp();
  }

  auth = getAuth(app);
  db = getFirestore(app);

  if (
    typeof window !== "undefined" &&
    process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === "true" &&
    !emulatorsConnected
  ) {
    connectAuthEmulator(auth, "http://localhost:9099", {
      disableWarnings: true,
    });
    connectFirestoreEmulator(db, "localhost", 8080);
    emulatorsConnected = true;
  }

  return { app, auth, db };
}
