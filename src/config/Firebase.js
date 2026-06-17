const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin SDK
let firebaseAdmin = null;

try {
  const serviceAccountPath = path.join(__dirname, 'truckast-app-firebase-adminsdk-fbsvc-9c40fa6a9f.json');
  
  // Initialize Firebase Admin if not already initialized
  if (!admin.apps.length) {
    firebaseAdmin = admin.initializeApp({
      credential: admin.credential.cert(serviceAccountPath)
    });
    console.log('✓ Firebase Admin SDK initialized successfully');
  } else {
    firebaseAdmin = admin.app();
  }
} catch (error) {
  console.error('⚠️  Firebase Admin SDK initialization failed:', error.message);
}

/**
 * Get Firebase Admin instance
 * @returns {admin.app.App} Firebase Admin app instance
 */
function getFirebaseAdmin() {
  if (!firebaseAdmin) {
    throw new Error('Firebase Admin SDK is not initialized. Please check your service account configuration.');
  }
  return firebaseAdmin;
}

/**
 * Get Firebase Cloud Messaging instance
 * @returns {admin.messaging.Messaging} FCM messaging instance
 */
function getMessaging() {
  return getFirebaseAdmin().messaging();
}

module.exports = {
  getFirebaseAdmin,
  getMessaging
};


