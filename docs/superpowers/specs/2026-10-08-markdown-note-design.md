# Markdown Note Type — Design

Tanggal: 2026-10-08

## Tujuan

Note punya tipe. Note bertipe `md` terbuka dalam tampilan Markdown yang sudah dirender, jadi teks Markdown
yang di-paste (README, hasil ChatGPT/Claude, dokumentasi) langsung terbaca dengan baik tanpa langkah tambahan.
Halaman share merender note `md` dengan renderer yang sama.

## Keputusan

| Hal | Keputusan |
|---|---|
| Tipe | Field `format` di note, nilai `text` (default) atau `md`. Tersinkron antar device |
| Cara jadi `md` | Dua jalur: button "New Markdown note" di list, dan toggle Markdown di header editor untuk mengonversi note yang ada |
| Konversi | Hanya membalik flag `format`; isi note tidak berubah, jadi selalu bisa dibalik |
| Tampilan | Note `md` terbuka rendered (View). Button Edit/Done berpindah ke textarea polos. Note `md` baru yang kosong langsung masuk Edit |
| Renderer | In-house GFM subset di `web/dist/md.js`, dipakai app dan halaman share, bisa diuji di Node |
| Checkbox task list | Read-only di tampilan rendered |
| Renderer lama | `renderMarkdown` / `markdownInline` di `app.js` dihapus; preview attachment `.md` memakai `md.js` |

## Data dan sync

**Kolom baru** `notes.format TEXT NOT NULL DEFAULT 'text'`, ditambahkan ke daftar `ALTER TABLE ... ADD COLUMN`
di `migrate()` (dijalankan lewat `execIgnoreDuplicateColumn`, sama seperti `is_pinned`). Tidak ada `CHECK` di
database; nilai divalidasi di server.

**Kontrak `push`:**
- `noteInput` dapat field opsional `format` (`json:"format"`). Nilai selain `""`, `text`, dan `md` ditolak dengan
  400 `VALIDATION_ERROR` ("format harus text atau md").
- **Kosong berarti pertahankan nilai yang ada** (note baru: `text`). Nilai ini diputuskan saat `candidate` dibuat,
  sebelum perbandingan `superseded/unchanged` dan sebelum upsert. Alasannya: upsert menimpa semua kolom dari
  payload, dan client lama yang masih ter-cache tidak mengirim `format`; tanpa aturan ini, edit dari client lama
  diam-diam mengembalikan note `md` menjadi `text`.
- Ganti `format` dihitung sebagai perubahan konten: membuat revision baru, dan masuk ke deteksi `unchanged` dan
  ke kondisi penulisan audit (`current.Format != candidate.Format`), sama seperti `is_pinned`.
- `note_audit` tidak menyimpan `format`. Restore dari history memakai `format` note saat ini.

**Titik yang disentuh di server** (`cmd/server/main.go`): struct `note`, struct `noteInput`, `validateMutation`,
konstruksi `candidate`, dua perbandingan di `push`, SQL upsert, `SELECT` di `pull`, `getNote`, dan `scanNote`.
Field di struct `note` ber-tag `json:"format"`, jadi `pull` otomatis mengirimnya.

**Titik yang disentuh di client** (`web/dist/app.js`):
- `setFormat(n, fmt)` mengikuti pola `togglePin`: ubah field, `updated_at = stamp(...)`, `mutation_id = uid()`,
  `saveLocal`, `paint`, `scheduleSync`. Konversi `text` → `md` memanggil `canonicalContent` pada isi sekali dulu.
- `newNote(format)` menerima tipe; note baru selalu punya `format` eksplisit.
- Mapping `push` di `pushOutbox` ditulis eksplisit dan server memakai `DisallowUnknownFields`, jadi `format`
  ditambahkan di situ **hanya jika `n.format` terdefinisi**. Salinan lokal yang di-pull sebelum upgrade tidak punya
  properti `format`; mengirim `text` untuk salinan seperti itu bisa menimpa `md` yang diset device lain.
- `mergeRemote` sudah menyalin field remote lewat spread; `keepLocalText` (edit lokal lebih baru) tidak menyalin
  `format`, sesuai aturan LWW. IndexedDB tidak perlu naik versi (store hanya ber-`keyPath`).
- Backup JSON (export/import) membawa `format`; import menerima `text`/`md`, selain itu `text`. Front matter
  export `.md` tidak berubah.

**Halaman share:** `POST /api/v1/shared/read` mengembalikan empat key: `title`, `content`, `format`, `updated_at`.
Query guard tidak berubah selain menambah kolom `n.format`. Test share yang menegaskan "tepat 3 key" diubah jadi 4.

**Batasan yang diketahui:** `DisallowUnknownFields` membuat server lama menolak `push` yang membawa `format`.
Rollback binary setelah klien baru terpasang akan menjeda sync note (toast "rejected by server"). Ini sifat
bawaan setiap field sync baru di project ini.

## Renderer `web/dist/md.js`

Classic script dengan pembungkus UMD: di browser mengekspos `window.LiteMd`, di Node `module.exports`.

**API:** `LiteMd.render(source, opts) → string` (HTML tanpa pembungkus; pemanggil membungkus dengan `.md`).
- `opts.attachment(name, id) → string`: dipanggil untuk baris yang persis `![nama](attach:uuid)`. App memberi
  kartu attachment (`attachCardHTML`), halaman share memberi label nama file. Default: label.
- `LiteMd.MAX_BYTES = 512 * 1024`.

**Cakupan:**
- Block: heading ATX `#`–`######`; paragraf (baris berurutan digabung; dua spasi atau `\` di akhir baris = `<br>`);
  `hr` (`---`, `***`, `___`); blockquote multi-baris dan bersarang; fenced code (``` dan `~~~`) dengan label
  bahasa; list ordered (`1.` / `1)`) dan unordered (`-`, `*`, `+`) yang bersarang lewat indentasi; task list
  (`- [ ]` / `- [x]`, checkbox `disabled`); table GFM (baris header + baris pemisah, alignment `:---` / `:---:` /
  `---:`, pipe ter-escape `\|`, baris pendek di-pad, sel berlebih diabaikan). Isi list item: paragraf lanjutan,
  list bersarang, dan fenced code yang di-indent.
- Inline: `` `code` `` (run backtick yang sama panjang membuka dan menutup); `**bold**` / `__bold__`;
  `*italic*` / `_italic_`; `~~strike~~`; `[teks](url)` dan `<url>`; URL `http(s)://` polos jadi link (tanda
  baca penutup `.,;:!?)` tidak ikut); escape backslash (`\*`).
- Underscore tidak menjadi emphasis di dalam kata (`snake_case_name` tetap teks).
- Gambar `![alt](url)`: jika `url` berskema `attach:` dan baris itu berdiri sendiri, diserahkan ke
  `opts.attachment`; selain itu tampil sebagai `<span class="md-image-label">[Image: alt]</span>` (tidak ada
  request keluar).
- Tidak termasuk: HTML mentah (di-escape dan tampil sebagai teks), setext heading, indented code block, footnote,
  reference-style link, definition list.

**Keamanan dan batas:**
- Semua teks di-escape sebelum markup apa pun ditambahkan; renderer tidak pernah meneruskan string dari note
  sebagai HTML.
- Hanya skema `http` dan `https` yang menjadi `<a href>`; `javascript:`, `data:`, `vbscript:`, dan skema lain
  (termasuk yang disamarkan dengan whitespace/entity) tampil sebagai teks. Link memakai `target="_blank"` dan
  `rel="noopener noreferrer"`.
- Input lebih dari `MAX_BYTES` (diukur dalam byte UTF-8) tidak diparse: dirender sebagai
  `<pre class="md-plain">` berisi teks ter-escape, didahului `<p class="md-notice">` yang menjelaskan alasannya.
  Ini melindungi tab penerima di halaman share dari konten yang sengaja berat.
- Kedalaman nesting (list/blockquote) dibatasi 20; di atas itu sisa baris dirender sebagai teks. Parser inline
  berjalan linear (tanpa backtracking regex yang bisa meledak).

**Penggantian renderer lama:** `renderMarkdown` dan `markdownInline` dihapus dari `app.js`;
`loadTextAttachmentPreview` memanggil `LiteMd.render`. Efek samping yang disengaja: preview attachment `.md`
mendukung table dan nested list. Class `md-code`, `md-code-language`, `md-task-list`, `md-image-label` dipertahankan.

**Aset:** `md.js` dan `md.css` baru. `md.css` memuat semua style render (termasuk yang sekarang ada untuk
`.markdown-preview` di `app.css`, dipindahkan) dan dipakai oleh `index.html` dan `share.html`. Keduanya masuk
`ASSETS` dan `ASSET_PATHS` di `sw.js` (app offline-first), dan versi aset naik dari 70 ke 71 di `index.html` dan
`sw.js`. `share.html`/`share.js` memuat `md.js` dan `md.css` dengan `?v=` sendiri dan menaikkan versi `share.js`.

## UI (`web/dist/app.js`, `app.css`)

**List:** di samping setiap button `+` (header mobile `#mobile-side-head` dan header desktop `#list-head`) ada
button kecil `data-act="new-md"` berikon Markdown, `aria-label="New Markdown note"`. Dua button, bukan menu, supaya
note biasa tetap satu tap. Ctrl+N dan empty state tetap membuat note biasa. `newNote('md')` membuat note
`format: 'md'` dan langsung masuk mode Edit.

**Header editor** (note non-Trash): button toggle `data-act="toggle-md"` (ikon Markdown, kelas `on` dan
`aria-pressed="true"` untuk note `md`) memanggil `setFormat`. Untuk note `md`, ada juga button `data-act="md-edit"`
berlabel "Edit" (saat View) atau "Done" (saat Edit). Toggle tidak tampil untuk note locked (konversi dan enkripsi
lokal note locked tidak dicampur); note `md` yang di-lock tetap punya button Edit/Done.

**Mode:**
- Setiap note `md` dibuka dalam View. Mode Edit hanya ada di memori (tidak disimpan); membuka ulang atau reload
  selalu kembali ke View, kecuali note baru yang kosong (langsung Edit).
- View: `<div class="md md-view" id="md-view">` berisi `LiteMd.render(content, { attachment: attachCardHTML })`.
  Klik kartu attachment tetap bekerja lewat delegasi `data-act="attach-open"`. Note `md` yang kosong menampilkan
  "Nothing to preview. Click Edit to start writing."
- Edit: `#content` adalah textarea polos yang terlihat (kelas `content-plain`), tanpa overlay `#content-render`.
- Pindah mode memanggil `flushSave()` lebih dulu, dan `editorKeyFor` memasukkan `format` dan mode supaya header
  dan body dirender ulang.
- View ikut berubah saat note berubah dari luar (hasil sync dari device lain). `refreshEditorChrome` sekarang
  `return` dini kalau `#content` tidak ada, yang di mode View berarti tampilan tidak pernah di-render ulang dan
  meta ("words", "Modified", nama folder) berhenti diperbarui. Untuk note `md` di View, fungsi itu merender ulang
  `#md-view` bila isi yang ditampilkan berbeda dari isi note, dan menghitung meta dari data note, bukan dari
  textarea. Render ulang dilewati selama `dirtyId` masih note ini (edit lokal yang belum tersimpan).
- Title (`#title`) tetap bisa diedit di kedua mode.
- Toolbar format untuk note `md`: button bold, italic, underline, checklist, dan bullet disembunyikan (menyisipkan
  `_x_`, 🟡, `•` yang bukan Markdown). Button pin dan attach tetap ada; undo/redo hanya tampil di mode Edit.
  Shortcut keyboard yang sudah ada tetap (Ctrl+B/I, auto-lanjut list, Cmd+Z global). `applyHistory` harus no-op
  (tanpa error) kalau tidak ada `#content`, seperti di mode View.

**Isi tidak boleh berubah diam-diam:** `normalizeContent` dan `canonicalContent` mengubah `- [ ]` ↔ 🟡 dan
`<u>…</u>` → `_…_`. Untuk note `md` keduanya dilewati, jadi teks yang di-paste tersimpan persis. Titik yang
disentuh: `persistable`, load editor (`content.value = normalizeContent(...)`), perbandingan di `refreshEditorChrome`
(`nContent`), dan import backup. `decContent` (snippet list dan search) boleh tetap memakai `normalizeContent`
karena hanya untuk tampilan; snippet list sudah memakai `stripMarkdown`.

**Attachment di mode View:** `insertAttachmentRef` sekarang langsung `return` kalau tidak ada `#content`, sehingga
file ter-upload (memakai quota) tetapi referensinya tidak pernah masuk note. Perbaikan: jika note `md` sedang di
View, editor pindah ke Edit lebih dulu, baru referensi disisipkan.

**Kartu attachment di View:** kartu digambar dari metadata attachment yang dimuat belakangan (saat boot atau setelah
online lagi), sementara isi note tidak berubah. `rerenderOverlay` (yang sudah dipanggil di titik-titik itu dan setelah
`removeAttachmentRefs`) karena itu menggambar ulang View secara paksa; tanpa itu kartu tersangkut berstatus "missing".

**Lain-lain:** note di Trash tampil rendered tanpa Edit dan tanpa toggle. Note locked: layar lock tidak berubah;
setelah unlock tampil sesuai tipenya. Berbagi note `md` tidak butuh aksi tambahan.

**Halaman share:** `share.js` memanggil `LiteMd.render(content, { attachment: <label> })` di dalam
`<div class="share-content md">` jika `format === 'md'`; jika tidak, jalur teks yang ada. Jika `LiteMd` gagal
dimuat, halaman menampilkan konten sebagai teks polos (bukan layar kosong).

## Testing

**Unit Node** (`web/e2e/md.test.mjs`, `node --test`, tanpa browser; memuat `../dist/md.js`):
- Fixture golden (input → HTML persis) untuk setiap elemen di bagian Cakupan, termasuk table dengan alignment dan
  `\|`, nested list tiga tingkat, task list, blockquote bersarang, fenced code berlabel, `snake_case_name`,
  autolink dengan tanda baca penutup, dan hard line break.
- Korpus XSS: `<script>`, `<img onerror>`, `[x](javascript:...)`, `[x](JaVaScRiPt:...)`, `[x](java&#9;script:...)`,
  `data:text/html`, `![x](javascript:...)`, `onerror` di alt, entity. Assert: tidak ada `<script`, tidak ada
  `href="javascript`, tidak ada atribut `on*` dari input.
- Input patologis (200.000 `[`; 200.000 `*`; 200.000 `_`; 100.000 `|`; 5.000 level `>`; 5.000 level indentasi list;
  satu baris 1 MB) selesai di bawah 1 detik tiap kasus.
- Batas `MAX_BYTES`: tepat di batas dirender, satu byte lebih fallback dengan `md-notice`.
- Semua kasus yang sebelumnya dipakai preview attachment (heading, list, checklist, quote, link, code) tetap benar.
- `opts.attachment` dipanggil untuk baris `![nama](attach:uuid)` dan tidak untuk gambar remote.

**Go** (`cmd/server/format_test.go`):
- `push` dengan `format: "md"` lalu `pull` mengembalikan `md`; note tanpa `format` berstatus `text`.
- `push` tanpa `format` ke note `md` yang sudah ada mempertahankan `md` (probe: matikan aturan "kosong berarti
  pertahankan", test harus gagal).
- Nilai tidak sah (`"html"`, `"MD"`) ditolak 400 dan tidak mengubah apa pun.
- Ganti `format` saja (isi sama) membuat revision baru, status `applied`, dan satu baris audit.
- Mengirim ulang mutation yang sama setelah ganti `format` berstatus `unchanged` (idempotent).
- `shared/read` mengembalikan `format` (4 key); test share yang ada diperbarui dari 3 ke 4 key.
- Migration idempotent: `migrate` dua kali pada DB lama tanpa kolom `format` berhasil dan note lama menjadi `text`.

**E2E (Playwright)** (`web/e2e/markdown.test.mjs`):
- "New Markdown note" membuka mode Edit; paste Markdown berisi heading, table, nested list; Done → tampil rendered
  (assert `<h1>`, `<table>`, `<ul><ul>`).
- Buka ulang note (navigasi ke note lain lalu kembali) dan reload halaman: tetap rendered. Mode Edit tidak bertahan.
- Toggle Markdown pada note biasa mengonversinya; toggle lagi mengembalikannya; teks tidak berubah satu karakter.
- `format` muncul di konteks browser kedua yang sudah login sebagai user yang sama setelah sync.
- Perubahan isi dari konteks kedua (lewat `push`) muncul di View yang sedang terbuka di konteks pertama setelah
  sync, tanpa reload, dan meta "Modified" ikut berubah.
- Isi note `md` yang berisi `- [ ] a`, `<u>x</u>`, dan `_y_` tersimpan persis (cek via `pull` mentah), tidak jadi 🟡 atau `_x_`.
- Upload attachment saat note `md` di View: referensi `![nama](attach:id)` masuk ke isi note dan tampil sebagai kartu.
  Setelah reload kartu berstatus `attach-link` (bukan `missing`), dan menghapus attachment dari manager menghilangkan
  kartunya dari View.
- Note `md` yang dibagikan dirender sebagai Markdown di `/s#token` (assert `<table>`), dan XSS payload Markdown tidak
  dieksekusi di sana.
- Note `text` tidak berubah: checklist emoji dan underline `_x_` tetap seperti sebelumnya (test e2e share dan
  e2e lama tetap hijau).
- Preview attachment `.md` masih tampil (memakai renderer baru).

**Guard shell** (Go, `cmd/server/shell_test.go`): setiap URL di `ASSETS` milik `sw.js` harus menjawab 200 (satu 404
membuat `addAll()` dan seluruh install service worker gagal), dan `index.html`, `sw.js`, serta nama cache harus memakai
satu nomor versi yang sama, dengan `md.js` dimuat sebelum `app.js`.

**Probe** (matikan, test relevan harus GAGAL, kembalikan): aturan "kosong berarti pertahankan", validasi `format`,
kondisi audit/`unchanged`, pengecualian `normalizeContent` untuk `md`, pindah ke Edit di `insertAttachmentRef`,
render ulang View di `refreshEditorChrome`, filter skema link, dan batas `MAX_BYTES`.

**Selesai berarti:** `gofmt -l` kosong, `go build`, `go vet`, `go test ./... -count=1`, `node --check` untuk
`app.js`, `sw.js`, `share.js`, `md.js`, `node --test` untuk `md.test.mjs`, e2e penuh, dan screenshot rendered
(light/dark, desktop/phone) yang saya periksa langsung. Tidak ada warning.

## Docs

`README.md`: fitur Markdown note, field `format`, dan perubahan preview attachment. Spec share
(`2026-10-08-share-note-design.md`) tidak diubah; perubahan `shared/read` (3 → 4 key) dicatat di sini.
