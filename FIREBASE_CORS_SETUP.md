# Firebase Storage CORS Setup

## Problem
The client-side PDF processing is blocked by CORS policy when trying to fetch files from Firebase Storage.

## Solution
Configure Firebase Storage to allow your Netlify domain to access the files.

## Steps to Fix:

### Option 1: Using Google Cloud Console (Recommended)

1. **Go to Google Cloud Console:**
   - Visit https://console.cloud.google.com/
   - Select your Firebase project

2. **Navigate to Cloud Storage:**
   - In the left menu, go to "Cloud Storage" → "Buckets"
   - Find your Firebase Storage bucket (usually named like "your-project.appspot.com")

3. **Configure CORS:**
   - Click on your bucket name
   - Go to the "Permissions" tab
   - Click "Add Principal"
   - Add "allUsers" with role "Storage Object Viewer" (for public read access)
   
   OR use the CORS configuration file:
   
4. **Upload CORS Config:**
   - Use Google Cloud Shell or local gcloud CLI
   - Run: `gsutil cors set cors.json gs://your-bucket-name`

### Option 2: Using Firebase Storage Rules

Go to Firebase Console → Storage → Rules and update to:

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read: if true; // Allow public read access
      allow write: if request.auth != null; // Allow write for authenticated users
    }
  }
}
```

### Option 3: Alternative Approach (If CORS can't be fixed)

If CORS issues persist, we can modify the approach to:
1. Download files server-side (via Netlify function)
2. Process them there and return text
3. Then send to Claude API from client

## Test
After applying CORS settings, refresh your app and try the spec analysis again.
