# Status

## Utang teknis

Cacat yang sudah diketahui dan sengaja belum diperbaiki, yang paling menyesatkan lebih dulu.
Tanggal dicatat: 2026-10-08.

### 1. Teks modal lock menjanjikan hal yang tidak terjadi

- **Di mana:** `web/dist/app.js`, `lockMenu()`. Deskripsi modal berbunyi "AES-256 end-to-end encryption — content is
  encrypted locally, plaintext is never stored on server."
- **Kenyataan:** `pushOutbox` sengaja mendekripsi note locked dan mengirim `title` dan `content` sebagai plaintext
  ("We must send plaintext to the server"), dan `pull` mengirimnya kembali apa adanya. Enkripsi hanya berlaku untuk
  salinan di IndexedDB; `password_hash` di server hanya menjadi guard untuk tampilan dan endpoint.
- **Dampak:** klaim keamanan yang menyesatkan. Pengguna bisa mengira isi note locked tidak terbaca di database.
- **Arah perbaikan:** ubah teksnya supaya jujur, atau buat enkripsi end-to-end sungguhan (perubahan besar: `push` mengirim
  ciphertext, dan share, search, serta tampilan Markdown harus tahu note terenkripsi).
- **Terkait:** fitur share dan tampilan Markdown menolak note locked lewat guard `password_hash`, bukan lewat enkripsi.

### 2. Non-goals MVP di PRD sudah basi

- **Di mana:** `PRD-notepad-pwa.md`, bagian 1.3.
- **Kenyataan:** attachment, folder, pin, checklist, dan version history masih tercatat sebagai non-goal, padahal semuanya
  sudah ada. (Baris shared note sudah diperbarui.)
- **Dampak:** dokumen menyesatkan pembaca baru.
- **Arah perbaikan:** perbarui daftar itu.

### 3. `/#/trash/<id>` lewat URL langsung tidak membuka note

- **Kenyataan:** membuka alamat itu langsung menampilkan state kosong, juga untuk note biasa (diverifikasi 2026-10-08).
  Membuka note yang sama lewat Trash di sidebar berjalan normal.
- **Dampak:** bookmark atau link ke note di Trash tidak berfungsi. Kecil.
- **Penyebab:** belum ditelusuri.

### 4. Backup binary di server tidak pernah dibersihkan

- **Di mana:** `deploy/README.md`, bagian Deploy. Tiap deploy membuat `litenotes.bak-<TS>` (sekitar 24 MB) tanpa langkah
  pembersihan.
- **Kenyataan:** pada 2026-10-08 ada 55 file (sekitar 1 GB) dan disk server 85% terpakai. Dibersihkan manual dengan menyisakan
  5 backup terbaru (disk 69%).
- **Dampak:** akan menumpuk lagi dan memenuhi disk.
- **Arah perbaikan:** tambahkan langkah "sisakan N backup terbaru" ke runbook deploy.
