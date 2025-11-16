# 🚀 Deployment Guide - Video Meeting App

Panduan lengkap deploy frontend (Vercel) dan signaling server (Render/Railway).

---

## 📋 Prerequisites

1. **GitHub Account** (untuk push code)
2. **Vercel Account** (gratis): https://vercel.com/signup
3. **Render Account** (gratis): https://render.com/signup (atau Railway)

---

## 🔧 Step 1: Push Code ke GitHub

```bash
# Di folder temuid
cd temuid
git init
git add .
git commit -m "Initial commit"
git branch -M main

# Buat repo baru di GitHub, lalu:
git remote add origin https://github.com/YOUR_USERNAME/temuid.git
git push -u origin main
```

**Signaling Server** (folder terpisah):

```bash
cd ../signaling-server
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/signaling-server.git
git push -u origin main
```

---

## 🌐 Step 2: Deploy Signaling Server (Render - GRATIS)

### Pilihan A: Render.com

1. Buka https://render.com → Sign up/Login
2. **New +** → **Web Service**
3. **Connect GitHub** → Pilih repo `signaling-server`
4. **Configure:**
   - **Name**: `temuid-signaling` (atau nama lain)
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free
5. Klik **Create Web Service**
6. Tunggu deploy (~2-3 menit)
7. **Copy URL** (misal: `https://temuid-signaling.onrender.com`)

✅ **Catatan**: URL akan jadi `https://your-app.onrender.com` (tanpa port)

---

### Pilihan B: Railway.app

1. Buka https://railway.app → Sign up/Login
2. **New Project** → **Deploy from GitHub repo**
3. Pilih repo `signaling-server`
4. Railway auto-detect → klik **Deploy**
5. Tunggu deploy
6. **Copy URL** dari tab **Settings** → **Domains**

---

## ⚡ Step 3: Deploy Frontend ke Vercel

1. Buka https://vercel.com → Sign up/Login
2. **Add New Project**
3. **Import Git Repository** → Pilih repo `temuid`
4. **Configure Project:**
   - **Framework Preset**: Next.js (auto-detect)
   - **Root Directory**: `./`
5. **Environment Variables:**
   - Klik **Environment Variables**
   - Tambah:
     ```
     Name: NEXT_PUBLIC_SIGNALING_URL
     Value: https://temuid-signaling.onrender.com
     ```
     (Ganti dengan URL signaling server dari Step 2)
6. Klik **Deploy**
7. Tunggu build (~2-3 menit)
8. **Copy URL** (misal: `https://temuid.vercel.app`)

---

## ✅ Step 4: Test!

1. Buka URL Vercel (misal: `https://temuid.vercel.app`)
2. Create room baru
3. Buka tab/window baru → Join room yang sama
4. Video P2P harusnya sudah terhubung! 🎉

---

## 🔍 Troubleshooting

### Signaling server tidak connect?

- Cek environment variable `NEXT_PUBLIC_SIGNALING_URL` di Vercel sudah benar
- Cek URL signaling server bisa diakses (buka di browser)
- Cek browser console untuk error

### Video tidak muncul?

- Cek permission kamera/mikrofon di browser
- Pastikan pakai HTTPS (Vercel sudah HTTPS otomatis)
- Cek console untuk error WebRTC

### Render.com free tier sleep setelah idle?

- Ya, Render free tier sleep setelah 15 menit tidak ada traffic
- First request akan butuh ~30 detik untuk wake up
- Solusi: Upgrade ke paid plan atau pakai Railway (lebih stabil)

---

## 📝 File Structure

```
temuid/                    → Deploy ke Vercel
├── app/
├── package.json
└── vercel.json

signaling-server/          → Deploy ke Render/Railway
├── server.js
├── package.json
└── README.md
```

---

## 🎯 Quick Commands

**Update environment variable di Vercel:**

1. Vercel Dashboard → Project → Settings → Environment Variables
2. Edit `NEXT_PUBLIC_SIGNALING_URL`
3. Redeploy

**Update signaling server:**

1. Edit code
2. `git push`
3. Render/Railway auto-redeploy

---

**Selamat deploy! 🚀**
