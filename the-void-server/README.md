# The Void – your own server

## 1. Deploy the backend (Render, free tier works)
1. Put the `void-server` folder in a new GitHub repo.
2. Render → New → Web Service → connect the repo (it reads `render.yaml`), or set manually:
   Build `npm install`, Start `npm start`.
3. Add environment variables (see `.env.example`):
   - `ADMIN_PASSWORD`  your admin login (10+ chars). Server won't start without it.

   - `CORS_ORIGIN`  your Cloudflare Pages URL, e.g. https://my-void.pages.dev
   - `PUBLIC_URL`  the Render URL, e.g. https://my-void-server.onrender.com
4. Open `<your render url>/health`, you should see `{"ok":true}`.

## 2. Point the front-end at it
Open `config.js` in the site folder and edit:
```js
SOCKET_URL: "https://my-void-server.onrender.com",
UPLOAD_URL: "https://my-void-server.onrender.com/upload",
```
Zip the site folder (files at the top level of the zip) and upload it to Cloudflare Pages (Workers & Pages → Create → Pages → Upload assets).

## 3. Admin login
On the lobby page use the admin button and enter your `ADMIN_PASSWORD`.
The password is checked only on the server; it is never in the page.

## Notes
- Render's free disk is wiped on restart, so uploaded photos disappear then.
  For permanent images, use S3/Cloudinary and change `/upload`.
- Free Render instances sleep when idle; the first connection can take ~30s.
- Run locally: `npm install && ADMIN_PASSWORD=yourpassword123 CORS_ORIGIN=http://localhost:5500 node server.js`
