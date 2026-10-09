# Status

## Utang teknis

Cacat yang sudah diketahui dan sengaja belum diperbaiki, yang paling menyesatkan lebih dulu.
Tanggal dicatat: 2026-10-08.

### 1. Non-goals MVP di PRD sudah basi

- **Di mana:** `PRD-notepad-pwa.md`, bagian 1.3.
- **Kenyataan:** attachment, folder, pin, checklist, dan version history masih tercatat sebagai non-goal, padahal semuanya
  sudah ada. (Baris shared note sudah diperbarui.)
- **Dampak:** dokumen menyesatkan pembaca baru.
- **Arah perbaikan:** perbarui daftar itu.

### 2. `/#/trash/<id>` lewat URL langsung tidak membuka note

- **Kenyataan:** membuka alamat itu langsung menampilkan state kosong, juga untuk note biasa (diverifikasi 2026-10-08).
  Membuka note yang sama lewat Trash di sidebar berjalan normal.
- **Dampak:** bookmark atau link ke note di Trash tidak berfungsi. Kecil.
- **Penyebab:** belum ditelusuri.

### 3. Backup binary di server tidak pernah dibersihkan

- **Di mana:** `deploy/README.md`, bagian Deploy. Tiap deploy membuat `litenotes.bak-<TS>` (sekitar 24 MB) tanpa langkah
  pembersihan.
- **Kenyataan:** pada 2026-10-08 ada 55 file (sekitar 1 GB) dan disk server 85% terpakai. Dibersihkan manual dengan menyisakan
  5 backup terbaru (disk 69%).
- **Dampak:** akan menumpuk lagi dan memenuhi disk.
- **Arah perbaikan:** tambahkan langkah "sisakan N backup terbaru" ke runbook deploy.
