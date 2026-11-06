# Discord Reminder Bot, versi Serverless (Vercel + cron eksternal)

Bot pengingat mingguan yang **berjalan sepenuhnya di Vercel** tanpa server atau proses yang hidup terus.

## Cara kerjanya

| Bagian | Endpoint | Fungsi |
|---|---|---|
| Slash command | `POST /api/interactions` | Discord mengirim webhook tiap ada `/reminder ...`. Tanda tangan diverifikasi memakai **Public Key**. |
| Pengiriman reminder | `GET /api/cron` | Dipanggil **tiap menit** oleh cron eksternal gratis (cron-job.org). Mengecek reminder yang jatuh tempo lalu mengirimnya lewat REST API Discord. |
| Database | PostgreSQL (Vercel/Prisma/Neon, dll.) | Sama seperti sebelumnya. |

Tidak ada koneksi Gateway, jadi bot akan tampil **offline** di daftar member, tetapi slash command dan reminder tetap berfungsi.

Kenapa cron eksternal: cron bawaan Vercel di paket Hobby hanya boleh sekali sehari, jadi tidak cocok untuk jadwal tepat waktu.

## Perbedaan dari versi lama

- Tidak ada `client.login()`, `node-cron`, atau PM2.
- **Jendela toleransi (`CATCHUP_MINUTES`, default 5):** kalau panggilan cron terlambat atau terlewat satu menit, reminder tetap terkirim selama masih dalam jendela itu. Reminder jam 23:59 tetap terkirim bila panggilan baru masuk setelah tengah malam.
- **Anti-ganda atomik:** reminder "diklaim" di database sebelum dikirim, jadi dua panggilan cron yang tumpang tindih tidak akan mengirim dua kali. Kalau pengiriman gagal, klaim dikembalikan dan dicoba lagi di menit berikutnya.
- Timestamp di pesan memakai **jam jadwal sebenarnya**, bukan jam saat pesan dikirim.
- `/reminder list` kini juga menampilkan role yang di-mention.

## Langkah setup

### 1. Siapkan database
Di komputermu (butuh `.env`, lihat langkah 2):
```bash
npm install
npm run setup-db
```
Perintah ini membuat tabel `reminders` (lengkap dengan `role_id`). Aman dijalankan ulang dan juga menambah kolom `role_id` pada tabel lama.

### 2. Isi `.env` lokal
Salin `.env.example` menjadi `.env`, lalu isi. Buat `CRON_SECRET` dengan:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
`DISCORD_PUBLIC_KEY` ada di Developer Portal, **General Information → Public Key**.

### 3. Deploy ke Vercel
1. Taruh seluruh isi folder ini di repository GitHub yang tersambung ke proyek Vercel-mu (ganti isi lama). **Jangan commit `.env`.**
2. Di Vercel: **Project → Settings → Environment Variables**, tambahkan:
   `DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DATABASE_URL`, `CRON_SECRET`, `CATCHUP_MINUTES` (opsional), `DEFAULT_TIMEZONE`.
   (`CLIENT_ID` dan `GUILD_ID` hanya dipakai lokal untuk mendaftarkan command.)
3. Pastikan **Framework Preset = Other** dan Root Directory menunjuk ke folder ini.
4. Deploy ulang setelah env var disimpan.

### 4. Hubungkan Discord ke Vercel
1. Developer Portal → aplikasimu → **General Information** → **Interactions Endpoint URL**.
2. Isi: `https://NAMA-PROYEKMU.vercel.app/api/interactions` lalu **Save Changes**.
3. Discord langsung mengirim tes (PING). Kalau muncul pesan sukses, endpoint sudah benar.

Daftarkan command (cukup sekali, atau saat `lib/commands.js` berubah):
```bash
npm run deploy-commands
```

> Setelah Interactions Endpoint URL diisi, Discord tidak lagi mengirim interaksi lewat Gateway. **Matikan bot versi lama** (PM2 atau `npm start` di PC) supaya tidak ada dua proses.

### 5. Pasang cron eksternal (gratis)
Contoh di https://cron-job.org (gratis, minimal interval satu menit, mendukung custom header):

1. Buat akun, lalu **Create cronjob**.
2. **URL:** `https://NAMA-PROYEKMU.vercel.app/api/cron`
3. **Schedule:** setiap 1 menit.
4. Tab **Advanced → Headers**, tambahkan: `Authorization` = `Bearer ISI_CRON_SECRET_KAMU`
5. Method **GET**, simpan, lalu klik **Test run**. Hasil yang benar:
   ```json
   {"checked":9,"sent":[],"skipped":0,"errors":[]}
   ```
   (`sent` terisi hanya saat ada reminder yang jatuh tempo.)

Kalau layananmu tidak mendukung custom header, pakai `https://.../api/cron?secret=ISI_CRON_SECRET`. Header lebih aman karena URL bisa tercatat di log.

## Pengujian

```bash
npm test
```
Menjalankan 21 pengecekan offline (tanpa database dan tanpa Discord): verifikasi tanda tangan, parsing command, logika jadwal (termasuk lewat tengah malam dan zona waktu), autentikasi cron, anti-ganda, dan retry.

Tes manual endpoint cron dari terminal:
```bash
curl -H "Authorization: Bearer ISI_CRON_SECRET" https://NAMA-PROYEKMU.vercel.app/api/cron
```

## Troubleshooting

| Gejala | Penyebab dan solusi |
|---|---|
| Discord menolak Interactions Endpoint URL | `DISCORD_PUBLIC_KEY` belum diisi atau belum redeploy. Atau **Deployment Protection** Vercel memblokir request: buka Settings → Deployment Protection dan matikan Vercel Authentication untuk production. Cek dengan `curl -X POST https://.../api/interactions`; hasilnya harus `invalid request signature`, bukan halaman login HTML. |
| `The application did not respond` | Discord butuh balasan dalam 3 detik. Cek **Vercel → Logs**. Biasanya `DATABASE_URL` salah atau database lambat saat cold start. Coba lagi, request kedua biasanya lebih cepat. |
| `/reminder` tidak muncul | Jalankan `npm run deploy-commands`, lalu restart Discord (Ctrl+R). |
| Cron test run mengembalikan 401 | Header `Authorization` salah atau `CRON_SECRET` di Vercel berbeda. Redeploy setelah mengubah env var. |
| Cron mengembalikan 500 `CRON_SECRET is not configured` | Env var belum diisi di Vercel. |
| `errors` berisi `Discord API 403` | Bot belum punya izin **View Channel** dan **Send Messages** di channel itu. |
| `errors` berisi `Discord API 404` | Channel sudah dihapus atau ID salah. |
| Role tidak menimbulkan notifikasi | Aktifkan **Allow anyone to @mention this role** pada role itu, atau beri role bot izin **Mention @everyone, @here, and All Roles**. |
| Reminder terlambat beberapa menit | Ketepatan bergantung pada layanan cron eksternal. Pesan tetap menampilkan jam jadwal yang benar. Naikkan `CATCHUP_MINUTES` bila sering terlewat. |

## Catatan

- Vercel Hobby hanya untuk penggunaan non-komersial.
- cron-job.org membatasi timeout tiap request 30 detik; fungsi ini selesai jauh lebih cepat.
- Satu hal tetap di luar kendali: kalau layanan cron eksternal sedang gangguan lebih lama dari `CATCHUP_MINUTES`, reminder pada rentang itu terlewat dan tidak dikirim susulan.
- **Keamanan:** jangan commit `.env`. Kalau token bot atau connection string pernah terbagi (misalnya terunggah ke chat atau repo publik), reset segera.
