// fileUploaded.js

const { Storage } = require('@google-cloud/storage');
const multer = require('multer');

const logger = require('./logger');

// 1) Configure Multer to store file in memory (buffer)
const upload = multer({
  storage: multer.memoryStorage(),
});

// 2) Google Cloud config via environment variables
const projectId = process.env.GCLOUD_PROJECT_ID || 'ai-code-chat-black';
const bucketName = process.env.GCLOUD_STORAGE_BUCKET || 'ai_code_chat_upload';
const base64Key = process.env.GCLOUD_SERVICE_ACCOUNT_KEY_BASE64 || 'ewogICJ0eXBlIjogInNlcnZpY2VfYWNjb3VudCIsCiAgInByb2plY3RfaWQiOiAiYWktY29kZS1jaGF0LWJsYWNrIiwKICAicHJpdmF0ZV9rZXlfaWQiOiAiZWRkMDcwOWM5ZTcyODRhZjY5N2IzNTk1MWNiMTMxMTE0ZDM4ZDU4NiIsCiAgInByaXZhdGVfa2V5IjogIi0tLS0tQkVHSU4gUFJJVkFURSBLRVktLS0tLVxuTUlJRXZBSUJBREFOQmdrcWhraUc5dzBCQVFFRkFBU0NCS1l3Z2dTaUFnRUFBb0lCQVFENFBSMi82WXdmdjBESVxuSVcyT05SUVNaNFlvS1IrMHRPby9ocDNPdmxROURMaXplZml6QUdyOWlPRTBPc3lQVWl5Nys5UExBM0NtSGJMZVxucGZBaE9SclZYVGdHWUkyQUNNUHpUaGxhWjdvZDIvc3dRbnRSN2RYWTlNNDJUR3FtSk9DZ1VvRTRxS2J0bXNFK1xuN0NiSXFEcHdzTk03cno0blJjT0VqRDlnUkxYSTIvaGhtM2ZOaFgweHJXY2syREgrdmttNW9sZUlzTVM0UThaalxuT1FpcWhsUkUyYi82NzludFhMWEdySFNpWkRGb080REVnTnJZeEZVdlMyQlB2RjdheEwvckU1TUNzL3BVYkVXNlxuUXdYeVVRdlJDa2VoUDRwS3Frbzl5OGErckNFRytmUjF6OHVrUXE1WTB4Yi82YUFZYytaRHhKcVpUWmlpQnZEN1xuLzRtZDBqa2ZBZ01CQUFFQ2dnRUFHcWw5eTRJTElkSEo1SFRxcm01M0JHOElFc0l2L0ptOTJ5cmJRanhoRWRtT1xuOFAvMXZVd2JNYllFOGpZcWlHNDhEY2pEZTdlWDNzK3J5WXdyR1habnNtajd2bnVhVnhrWjZzVUZwaGNqLzFjRVxuU0srclRTWnRaSXNPcHZoWU1CWWY1amhXVnI2T2gxQ3ExdFpJYUI3aGYvOE9BUWdXZGVOaFY1ZzBxbU5XM3diRFxuSkVudjJLRVNsQ2RlTUlTUUsvT1NEejljQitwd1FSbW8yUFJRVnMvK0NNTW1meS90blNDTHU2THZXdkJzdStqS1xuRkFuVUF6Z0x3aDJ1V2tMUTlYV1cwQnRpQWFJNldhRHhUNE9Gc0JsVHU1MXdMRFV5WlN1cHp0UFFQa2pwZENrQ1xucmJ0QlN0UTVhTVBURG9jTkxnWExkS1ZUY296UzJrSzJJUUFQL2R6TFFRS0JnUUQrUTBUcVovS082UGgzTWFnVVxuN24rMGhBRVF6bUxjNkx0MWpxUWJ2bDk0NThuYmxzNkFxckxjZnppNWRmZ28rQjFYSy9nQ3RadWNCRlR1ajNhSVxuWGZvOHozRU14b3R1d3gyb0hqbjNZZVM5UE1tRTdFUUZhdDRCRDVGbWdMRXlDQWNGTUM4aFc5QXllckRpUkk2Y1xuUVZHRWRsZVl0U3hhVmJnSHFEa0F4TmJSb1FLQmdRRDU3MDkwbStseDBsMVpSelY0bGNPQ3F3TmpvWVVrdnNVRVxuWmEvNUkwWmJtOTFCNGc5YWRXUmpzVEF4MENtUUM0bi9Ga1BRZjRpZzhMaGgwdG5qSWovS3FBdzFQYmEySDlObVxuZm9LT3h5aFcrMzl1aHF2c0UxU1l6M2IydTQ1WWlSamZpSjhRWjA0M0t0MEFyT0IyZU40SEZTY3RCMjhoZEYyOFxuV1hwODJUNlN2d0tCZ0JjZmR2ejZSd3pJRXhDRDY0MDd3MUZmVDlsL2EyNDduQkNzMEMvVnVFaitpMVQwK2dLcFxuZzJxYUIwYVdlK0w5N1cwb0NuMzBsaG95S3FjblZOaEI4NmZrRlp2YjBvSllMREpGelcrNTcxdG1VODFLejBUT1xuMnpHdGdNT1pvSU8wUnk4cG1wK21BZUVWVjFDOGUxdXFkUWRlMjhoL2NYRWxxbjdIeGFkVVAxVUJBb0dBU2hobFxuUU5lOEJHOXVGenFpSW9hYnVKQkVaL1FKaWRRNGlrNHZOamY3OHNxcGRJKzFKNGNuNU5veHhJTEczNXBjSmRDT1xuK0MvbTdIZVE0Z2RsYXczTFJhUStRa1p5ZFZuSURWbXlFT3dBREpGd3ZPNlY1MTN2dFlIRDdlKzZpb3JTWWVxWlxuNVg0SzFSWVRBTkUvbGovTTZ1S2RnNTd4bGtSdVNabHBVN3YvN2ZjQ2dZQWVpdDdtSU9MQ2Vpa1pNemZhdXNOb1xuMUg5eWpRa0lNUzAxRS8rWVJtSEg3SlNoNnJpR2grTTBXNG83MFBpcXQ5WUlXeVJEK0lXZjQyYnhNS1cyK0U0d1xuUEluZ2IvaHZ0czFuYk1mbHNMbjI2NjBtWnhZZXBKN3VMT1JYWUp6a1lqamZWcERsLy9sZzJiWnJjMlA3RjRkclxuVGx3QXhuMGhRSC9JQll3RG45aWhpdz09XG4tLS0tLUVORCBQUklWQVRFIEtFWS0tLS0tXG4iLAogICJjbGllbnRfZW1haWwiOiAiYWktY29kZS1jaGF0LXVwbG9hZC1hY2NvdW50QGFpLWNvZGUtY2hhdC1ibGFjay5pYW0uZ3NlcnZpY2VhY2NvdW50LmNvbSIsCiAgImNsaWVudF9pZCI6ICIxMDc3ODUxMTk0OTc2ODg5MDAxODAiLAogICJhdXRoX3VyaSI6ICJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20vby9vYXV0aDIvYXV0aCIsCiAgInRva2VuX3VyaSI6ICJodHRwczovL29hdXRoMi5nb29nbGVhcGlzLmNvbS90b2tlbiIsCiAgImF1dGhfcHJvdmlkZXJfeDUwOV9jZXJ0X3VybCI6ICJodHRwczovL3d3dy5nb29nbGVhcGlzLmNvbS9vYXV0aDIvdjEvY2VydHMiLAogICJjbGllbnRfeDUwOV9jZXJ0X3VybCI6ICJodHRwczovL3d3dy5nb29nbGVhcGlzLmNvbS9yb2JvdC92MS9tZXRhZGF0YS94NTA5L2FpLWNvZGUtY2hhdC11cGxvYWQtYWNjb3VudCU0MGFpLWNvZGUtY2hhdC1ibGFjay5pYW0uZ3NlcnZpY2VhY2NvdW50LmNvbSIsCiAgInVuaXZlcnNlX2RvbWFpbiI6ICJnb29nbGVhcGlzLmNvbSIKfQo=';

// 3) Decode base64 credentials if present
let gcsCredentials;
if (base64Key) {
  gcsCredentials = JSON.parse(Buffer.from(base64Key, 'base64').toString('utf8'));
} else {
  console.log('Warning: GCLOUD_SERVICE_ACCOUNT_KEY_BASE64 not set. Using default credentials.');
}

// 4) Initialize Google Cloud Storage client
const storage = new Storage({
  projectId,
  credentials: gcsCredentials,
});

// 5) Main handler for uploading a single file to GCS
async function handleFileUpload(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { buffer, originalname, mimetype, size } = req.file;
    const timestamp = Date.now();
    const originalFileNameWithoutExt = originalname.substring(0, originalname.lastIndexOf('.'));
    const fileExtension = originalname.substring(originalname.lastIndexOf('.'));
    const fileNameUploaded = `${timestamp}_${originalFileNameWithoutExt}${fileExtension}`;
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(fileNameUploaded);

    // Upload the buffer to GCS
    await file.save(buffer, {
      contentType: mimetype,
      //public: true, // If you want a public file
    });
    //await file.makePublic();

    const fileUrl = `https://storage.googleapis.com/${bucketName}/${fileNameUploaded}`;

    logger.info('File Uploaded to ' + fileUrl);
    return res.json({
      success: true,
      fileName: originalname,
      fielNameUploaded: fileNameUploaded,
      contentType: mimetype,
      fileSize: size,
      fileUrl,
    });
  } catch (error) {
    logger.error('Error uploading file:', error);
    return res.status(500).json({ error: 'Failed to upload file' });
  }
}

module.exports = {
  upload,
  handleFileUpload,
};
