# Proje hafızası ve doküman kaydı planı

Tarih: 2026-11-25. Durum: Faz 0 başladı.

## Amaç

Uzun süren projelerde bağlamı yerelde özet olarak tutmak, proje bütünlüğünü korumak ve her oturumda depoyu yeniden taramayı önlemek. Bunu yaparken Team Lead context'ini şişirmemek ve oturum başına ek model çağrısı yapmamak.

## Değerlendirilen ve eklenmeyenler

**claude-mem (thedotmack/claude-mem, Apache-2.0).** Bağımlılık olarak eklenmedi:

- Her tool çağrısını varsayılan olarak Haiku ile özetliyor; bu çağrılar kullanıcının planından düşüyor.
- Antigravity ve Cursor ayrı süreçte çalıştığı için mühendisin işini görmüyor.
- Her oturum başında varsayılan olarak 50 gözlem enjekte ediyor; politika görev sınırında `/clear` istediği için bu yük her `/clear`'dan sonra yeniden ödeniyor.
- Bun, Chroma ve bir arka plan worker'ı istiyor; global plugin olarak kuruluyor ve proje bazında açılıp kapatılamıyor, bu da bench'teki K0/K2 izolasyonunu bozar.
- Telemetri varsayılan olarak açık.

Alınan fikirler: kademeli erişim (oturuma küçük bir indeks girer, detay gerektiğinde okunur), tazelik kontrolü, gizli içeriğin hafızaya yazılmaması.

**Context7 (upstash/context7, MIT).** Kullanıcı kararıyla eklenmedi. Yerine aşağıdaki doküman kaydı geliyor.

## İlke: "güncel doküman" = projede kurulu sürüm

Kütüphanenin en son sürümünün dokümanı, projede kurulu olmayan API'ler önerebilir. Doğru kaynak, lockfile'daki sürümün dokümanıdır. Daha yeni bir sürüm çıkmışsa bu yalnızca "yükseltme mevcut" notu olarak kaydedilir.

## Fazlar

### Faz 0: Ucuz ölçüm altyapısı

Yeni koşu gerektirmez. Diskte duran Claude Code transcript'lerini (`~/.claude/projects/<proje>/*.jsonl`) analiz eden bir script:

- oturum başındaki keşif çağrıları (Read/Grep/Glob ve Bash ile yapılan listeleme/arama) ve bunların sonuç boyutu;
- aynı dosyanın aynı projede birden fazla oturumda okunma oranı (oturumlar arası tekrar tarama);
- oturum başına Team Lead token'ı.

Bu, mevcut kullanımdan sıfır maliyetle bir başlangıç değeri verir.

Durum: uygulandı, `scripts/bench/analyze-rescans.mjs`. İlk ölçüm (bu depo, 6 oturum, 2026-09-28 ile 2026-11-25 arası, yalnızca diskte kalan transcript'ler): 36 farklı dosya okunmuş, 6'sı birden fazla oturumda (genel tekrar okuma oranı yüzde 18, yaklaşık 14,8k token). Oturum başı keşif, ilk düzenlemeye kadar oturum başına yaklaşık 0 ile 23k token arasında. Okumaların çoğu `Read` aracıyla değil, shell komutlarıyla yapılmış. Örneklem küçük; bu sayılar yalnızca bu ortam ve bu tarih için geçerlidir. Sonraki fazlardaki hook'lar ayrıca yerel bir log'a pasif sayaç yazar (kayıt isabeti, sürüm uyuşmazlığı, oturum başı tarama sayısı).

### Faz 1: Proje defteri

Hedef repoda `.aeo/memory/`:

- `INDEX.md`: en fazla ~1,5k token. Modül haritası, konvansiyonlar, test komutları, açık kararlar, son görevlerin birer satırlık özeti.
- `tasks/<tarih>-<konu>.md`: kontrat, delegasyon ID'leri ve sonuçları, değişen dosyalar, karar, açık bulgular.

Bridge görev kaydını delegasyon sonucundan (rapor + diffstat) yazar. Team Lead yalnızca son karar satırını ekler. LLM çağrısı yok.

Tasarım (aeo-architect, 2026-11-25): her olay için ayrı ve değişmez bir dosya (`tasks/<UTC>-<kind>-<ref>-<nonce>.md`); INDEX.md'yi yalnızca CLI yazar; `.aeo/memory/` kendi `.gitignore`'u ile varsayılan olarak git dışında; `AEO_MEMORY=auto|on|off` (auto: klasör varsa yazar); iki bridge'de birebir aynı `lib/ledger.js`.

Dilimler:
1. Uygulandı: `ledger.js`, Antigravity bridge bağlantısı, araç sonucuna `Ledger:` satırı, installer listesi.
2. Uygulandı: Cursor bridge bağlantısı, apply/discard kayıtları, `git apply --exclude=.aeo/memory/*`, yerinde çalıştırmada bütünlük uyarısı, prompt kuralı, worktree kökü kontrolünün `resolveWorktreeRoot` ile yapılması.
3. Uygulandı (iki engineer'ın kotası dolduğu için kullanıcının talimatıyla Team Lead uyguladı; aeo-reviewer incelemesindeki 8 bulgu düzeltildi): `memory.js` CLI (`init`, `decide`, `reindex`, `status`), INDEX işaretçileri, `docs.md` başlığı, `docs/project-memory.md`, politika paragrafı.

### Faz 2: Enjeksiyon ve compact koruması

Durum (2026-11-26): uygulandı. Delegasyon kayıtları çalıştırma öncesi `git status --short` baseline'ını taşıyor (Bölüm A: Antigravity'nin üç kez aynı araç hatasıyla düşmesi üzerine politika istisnasıyla Team Lead uyguladı). `memory.js hook session-start` INDEX'i, docs kaydı özetini ve son karardan sonraki açık delegasyonları enjekte ediyor; `compact`/`resume`'da en yeni açık delegasyonun baseline'ını ve kontrat özetini de ekliyor (Bölüm B: Antigravity). Hook kaydı elle yapılıyor; Codex'te karşılığı yok.

- `SessionStart` hook'u yalnızca `INDEX.md`'yi enjekte eder. Detay gerektiğinde Read/Grep ile okunur.
- Compact sonrasında beş madde (baseline, kontrat, delegasyon ID'leri, açık bulgular, son karar) geri yüklenir.
- Politika: keşiften önce INDEX'i ve doküman kaydını oku; kontrata ilgili INDEX ve kayıt satırlarını koy, böylece mühendis de baştan taramaz.
- Codex: aynı kurallar metin olarak eklenir.

### Faz 3: Doküman kaydı (`.aeo/memory/docs.md`)

Durum (2026-11-26): uygulandı (Antigravity). `memory.js docs check` ve `docs set`; npm (`package-lock.json` v1-v3, yalnızca üst seviye paketler) ve Composer (`composer.lock`), alt klasör için `composer@platform` biçimi. Oturum başı bloğu yalnızca uyuşmazlıkları gösterir; sayaç satırına `docsMismatches` eklendi. Diğer ekosistemler `unchecked` olarak raporlanır.

Her bağımlılık için bir satır: kütüphane, kurulu sürüm, kaynak, doğrulama tarihi, notlar.

Kaynak öncelik sırası:

1. Repodaki kurulu paket kaynağı (`vendor/`, `node_modules/`; tipler, docblock'lar, CHANGELOG). Sürümü kesin doğrudur, ağ gerektirmez.
2. Resmi sitenin sürümlü doküman adresi (ör. `/docs/11.x`).
3. Web araması; bulunan kaynak kayda yazılır.

Notlar sütunu o sürümde öğrenilmiş tuzakları tutar. Kayıt ilk bakışta yazılır, görev APPROVED olunca güncellenir.

Oturum başında deterministik bir script lockfile sürümlerini kayıtla karşılaştırır. Sürümler eşleşiyorsa context'e hiçbir şey eklenmez; değişen sürüm için tek satırlık bir uyarı girer ve model o kütüphanenin kaynağını yeniden çözer.

### Faz 4: Tazelik

Durum (2026-11-26): uygulandı (Antigravity). Bölüm başlığının altındaki `<!-- verified: <sha> paths: ... -->` işaretçisi; `memory.js verify --section <başlık> [--paths]` ve `memory.js freshness`. Oturum başı bloğunda `## INDEX freshness` yalnızca eski, doğrulanmamış veya bilinmeyen commit'li bölümleri değişen dosyalarıyla (en fazla 5) listeler; sayaç satırına `staleSections` eklendi. Commit edilmemiş değişiklikler de sayılır, `.aeo/memory/` hariç tutulur.

INDEX'teki her bölüm bir commit SHA'sı taşır. O SHA'dan sonra değişen yollar "eski" diye işaretlenir ve yalnızca onlar yeniden taranır. Doküman tazeliğini Faz 3'teki lockfile kontrolü sağlar.

### Faz 5: Tek küçük A/B ve karar

Durum (2026-11-26): ilk çift koşuldu, sonuç belirsiz; ikinci tekrar bilinçli olarak yapılmadı. Runner: `scripts/bench/run-memory-ab.mjs`. Ortam: `C:\bench\kimlik-k2` (commit 3e4ea22), kullanıcının normal Claude ayarı (bench ayar klasörünün OAuth girişi bozulduğu için), 3 soru oturumu, mühendis çağrısı yok. Toplam maliyet yaklaşık 3,0 USD.

| Oturum | Hafıza açık: girdi eşdeğeri token / USD / tur | Hafıza kapalı: girdi eşdeğeri token / USD / tur |
| --- | --- | --- |
| 1 | 688k / 0,68 / 10 | 520k / 0,53 / 7 |
| 2 | 443k / 0,58 / 7 | 447k / 0,48 / 8 |
| 3 | 262k / 0,38 / 4 | 472k / 0,36 / 7 |

Oturum 2+3: token yüzde 23 daha az, maliyet yüzde 15 daha fazla. İki ölçü ters yönde ve her koşulda tek koşu var; bu gürültüden ayırt edilemez. Asıl bulgu: hafıza açık kolda `INDEX.md` hiç doldurulmadı (her oturumda 373 karakterlik iskelet kaldı); model soru oturumlarında doldurma kuralını uygulamadı. Yani bu A/B "boş INDEX enjeksiyonu"nu ölçtü, hafızanın kendisini değil; ikinci tekrar aynı boşluğu ölçeceği için koşulmadı. Ayrıca `analyze-rescans.mjs` `cd x; cat y` biçimindeki shell okumalarını saymıyor, bu yüzden keşif çağrısı sayıları bu koşuda güvenilir değil. Sonraki adım: INDEX'in ilk doldurulmasını modele bırakmamak (deterministik bir başlangıç ya da açık bir ilk-oturum adımı) ve analizcideki `cd ...;` önekini düzeltmek; ardından A/B tekrar edilir.

İkinci çift (2026-11-26, düzeltmelerden sonra): `memory.js seed` boş Modules ve Test commands bölümlerini git'ten deterministik olarak dolduruyor (kimlik'te 41 + 2 satır, INDEX 1931 karakter); oturum bloğu boş bölümler için açık bir "doldur" satırı gösteriyor; analizci `cd x; cat y` biçimini sayıyor. Toplam maliyet yaklaşık 2,7 USD.

| Oturum | Hafıza açık (seed): token / USD / tur / keşif çağrısı | Hafıza kapalı: token / USD / tur / keşif çağrısı |
| --- | --- | --- |
| 1 | 611k / 0,54 / 10 / 9 | 517k / 0,49 / 8 / 7 |
| 2 | 585k / 0,52 / 10 / 9 | 607k / 0,52 / 8 / 6 |
| 3 | 274k / 0,33 / 4 / 3 | 334k / 0,32 / 5 / 4 |

Oturum 2+3: token yüzde 8,8 daha az, maliyet yüzde 3,1 daha fazla; durma kuralı (eşik yüzde 15) ikinci tekrarı gereksiz buldu. Model boş Conventions ve Open decisions bölümlerini açık talimata rağmen yine doldurmadı. Keşif çağrıları azalmadı: sorular dosya içeriği gerektiriyor, dizin haritası bunun yerini tutmuyor.

Karar: bu senaryoda (soru oturumları, tek depo, bu ortam ve bu tarih) hafıza ölçülebilir bir token veya maliyet kazancı sağlamıyor. Varsayılan `AEO_MEMORY=auto` (yalnızca `init` yapılmış depolarda yazar) olarak kalır; README'ye kazanç iddiası girmez. Ölçülmeyen ve hâlâ gerekçe olan kullanımlar: compact sonrası açık görevin baseline ve kontratını geri yükleme, karar geçmişi, doküman kaydı ve sürüm uyuşmazlığı uyarısı. Bunların değeri token değil süreklilik; ayrıca ölçülmedi.

Tam bench yerine (5 görev × 3 koşul × 3 tekrar = 45 koşu) tek senaryo: aynı küçük repoda 3 ardışık oturum. 2 koşul (hafıza açık/kapalı) × 2 tekrar, headless `claude -p` ve tur sınırıyla. İlk çiftte fark gürültü seviyesindeyse ikinci tekrar yapılmaz. Karar bu A/B, Faz 0 başlangıç değeri ve pasif sayaçlarla verilir. README'ye sayılar yalnızca "bu ortamda, bu tarihte" notuyla girer.

## Uygulama

- aeo-architect bir kez çalışır ve Faz 1 ile Faz 3'ün dosya formatlarını birlikte tasarlar.
- Antigravity Faz 0-4'ü sıralı ve küçük kontratlarla uygular; Team Lead her adımı diff ve testle doğrular.
