import * as admin from "firebase-admin";

/**
 * Initializes the trusted Firebase Admin SDK for server-side API routes and Cloud Functions.
 * Credentials are read strictly from server-side environment variables and NEVER exposed to the browser or ESP32.
 */
export function getFirebaseAdmin() {
  if (!admin.apps.length) {
    const projectId =
      process.env.FIREBASE_PROJECT_ID ||
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
      "healthos-ng-iot";
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

    if (clientEmail && privateKey && !privateKey.includes("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...")) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
        projectId,
      });
    } else {
      admin.initializeApp({ projectId });
    }
  }

  return {
    adminAuth: admin.auth(),
    adminDb: admin.firestore(),
  };
}
