# Context hijyeni analizi ve ölçüm (benchmark) planı

Tarih: 2026-10-21. Durum: öneri, uygulanmadı.

Bu doküman iki soruyu yanıtlar:

1. "Context'i otomatik temizleyen skill" diye anlatılan şeyler gerçekte nedir, AEO'ya ne kazandırır, ne kaybettirir?
2. AEO varken ve yokken token/performans farkını nasıl kanıtlarız?

## 1. Bulgular: "otomatik context temizleme" aslında ne?

Resmi Claude Code dokümanlarına göre durum şu:

| Mekanizma | Resmi mi? | Ne yapar |
| --- | --- | --- |
| `/clear` | Evet | Konuşmayı sıfırlar. Anthropic "görevler arasında `/clear` kullanın" diyor. |
| `/compact [odak]` | Evet | Geçmişi yapılandırılmış özete çevirir. Odak talimatı alır. `CLAUDE.md` içindeki `# Compact instructions` bölümü özetin neyi koruyacağını yönlendirir. |
| Auto-compact, `/autocompact <N>` | Evet | Pencere dolmaya yaklaşınca otomatik özetler; eşik ayarlanabilir. |
| Tool-result clearing | Evet (ad geçiyor, ayar yok) | Eski tool çıktılarını context'ten düşürür. Prompt cache'i yeniden kurdurur. |
| Subagent `autoCompactWindow` | Evet | Her subagent kendi izole penceresinde çalışır; daha erken compact edilebilir. |
| Skill `context: fork` | Evet | Skill'i ayrı bir subagent context'inde çalıştırır; ana konuşmaya yalnızca sonuç döner. |
| Hook `PostToolUse.updatedToolOutput` | Evet | Tool çıktısını Claude'a gitmeden önce değiştirir/kısaltır. MCP araçları için de çalışır. |
| Hook `PreCompact` / `PostCompact` / `SessionStart(compact)` | Evet | Compact öncesi durumu dosyaya dökmek ve compact sonrası geri enjekte etmek için. |
| Skill'in kendi başına `/clear` çalıştırması | **Hayır** | İstek olarak açıldı (anthropics/claude-code#45091), Nisan 2026'da #37307'nin kopyası diye kapatıldı. Model `/clear` çalıştıramaz. |

Sonuç: Sosyal medyada "context'i otomatik temizleyen skill" diye dolaşan şeyler iki türden biri. Ya `context: fork` ile işi subagent'a atan bir skill, ya da modele "şimdi `/compact` öner, durumu dosyaya yaz" diyen bir prompt. Gerçek bir "otomatik temizleme" yok; kullanıcı `/clear` yazmak zorunda.

Ölçülmüş tek resmi sayı Anthropic cookbook'undan: SDK tarafında `compaction_control` ile 26 turluk bir ajan döngüsünde toplam token 208.838'den 86.446'ya indi (yüzde 58,6 azalma, 2 compaction). Bu Claude Code değil, API tool-runner. Üçüncü taraf blog sayıları (yüzde 30 daha az hata, 185k'dan 120k'ya vb.) ölçüm yöntemi verilmeden yazılmış, kanıt sayılmaz.

Önemli karşı bulgu: Subagent kullanımı ana context'in dolmasını geciktirir ama toplam token kullanımını artırabilir. Bir geliştirici 150k tokenlik işin subagent'larla 250k'ya çıktığını, buna karşın 80'den fazla auto-compact'tan kurtulduğunu bildiriyor. Yani "context temizlemek" tasarruf değil, kaliteyi korumak için yapılan bir yatırımdır. Tasarruf ancak pahalı modelin penceresi kısalırsa gelir.

## 2. AEO bugün context'i nasıl yönetiyor?

Bridge ve preset'lere bakınca AEO'nun mimarisi zaten en büyük izolasyonu sağlıyor:

- **Antigravity ayrı süreçte çalışır.** Mühendisin tüm dosya okumaları, düzenlemeleri, test çıktıları Team Lead'in context'ine hiç girmez. Her `delegate_antigravity` çağrısı sıfırdan bir `agy` süreci, yani "delege edilen iş zaten yeni session'da yapılıyor." Revizyon da yeni süreçtir; worktree revizyonunda yalnızca dosya sistemi korunur, context korunmaz.
- **aeo-explorer / architect / reviewer subagent'tır.** Kendi izole pencereleri var, ana konuşmaya yalnızca sonuç döner.

Team Lead context'ine giren şeyler şunlar, ve sızıntı burada:

| Kaynak | Boyut | Not |
| --- | --- | --- |
| Delegasyon raporu (`agent_success` metni) | `MAX_REPORT_CHARS = 120_000` karakter, yaklaşık 30k token üst sınır | `bridge/antigravity-mcp/lib/delegate.js:26`. Mühendis uzun yazarsa her delegasyon 30k token yer; 3 revizyon 90k. |
| CLI diagnostics bloğu | Aynı 120k sınır | Stderr; izin uyarıları, model fallback notları. |
| Kontrat (prompt) | 24k karakter üst sınır | Team Lead'in kendi çıktısı, context'te kalır. |
| Diff okuma, `git status`, test çıktısı | Sınırsız | Team Lead'in doğrulama adımı. `npm test` çıktısı tek başına 10-20k token olabilir. |
| Sabit yük | Rules + agent tanımları + MCP tool şemaları | Her `/clear` sonrası yeniden yüklenir. |

Bu oturumun transkriptinden bir örnek: tek bir asistan mesajında `cache_read_input_tokens: 101630`. Yani ana konuşma 100k'nın üzerinde taşınıyor ve bunun büyük kısmı önbellekten okunuyor. Önbellekten okuma, taze giriş tokeninin onda biri fiyatına. Bu, "sık sık `/clear`" önerisinin maliyet tarafındaki tuzağıdır: her `/clear` önbelleği sıfırlar, sabit yük taze token olarak geri gelir.

## 3. Fayda/zarar: AEO'ya ne eklenmeli, ne eklenmemeli

### Eklenmeli (net fayda)

**A. Rapor boyutunu düşür ve dışarı al.** Bridge'in 120k karakterlik rapor tavanı Team Lead context'ine giren en büyük tek kalem. Öneri: tavanı `AEO_MAX_REPORT_CHARS` ile ayarlanabilir yap, varsayılanı 24-32k karaktere çek; tam raporu `<worktree-root veya os tmpdir>/aeo-antigravity/runs/<id>/report.md` dosyasına yaz ve tool sonucuna yol + diffstat + ilk N karakteri koy. Team Lead zaten raporu kanıt değil ipucu sayıyor; diff'i kendisi okumak zorunda. Fayda: delegasyon başına 20-25k token tasarruf, revizyonlarda katlanıyor. Zarar: Team Lead gerektiğinde dosyayı açmalı; bu zaten var olan "raporu okuyup depoyu kontrol et" kuralına uyuyor. Bu, substantive bridge değişikliğidir, Antigravity'ye delege edilir.

**B. Compact talimatı ekle.** Claude preset kuralına `# Compact instructions` bölümü: baseline `git status --short`, aktif kontrat, delegasyon ID'leri, açık bulgular ve verilen karar (APPROVED / CHANGES REQUIRED) özetten düşmesin. Bu kural olmadan auto-compact baseline'ı silebilir; baseline yoksa AEO'nun "sahiplik atfı" kuralı çalışmaz ve kullanıcının kirli dosyaları Antigravity'ye atfedilebilir. Maliyeti sıfır; sadece doküman değişikliği. Codex preset'inde karşılığı yok, bu asimetriyi dokümanda belirt.

**C. Görev başına `/clear` öner, görev içinde önerme.** Politikaya kısa bir "context hijyeni" bölümü: bir görev APPROVED ile kapanınca ve bir sonraki görev öncekine dayanmıyorsa `/clear`. Görev içinde (delegasyon, revizyon, gözden geçirme) `/clear` yapma, çünkü baseline ve kontrat kaybolur. Zaten Anthropic'in resmi önerisi.

**D. Test çıktısını filtrele.** Team Lead'in doğrulama adımında `npm test` çıktısı değil yalnızca başarısız testler context'e girmeli. İki yol: doğrulamayı `aeo-explorer` benzeri ucuz bir subagent'a yaptırıp özet almak, ya da Claude preset'ine örnek bir `PostToolUse` hook'u (Bash için `updatedToolOutput` ile yalnızca hata satırlarını bırakan) koymak. Hook yolu yalnızca Claude'a özgü, opsiyonel örnek olarak sunulmalı.

### Eklenmemeli ya da ertelenmeli

**E. "Delegasyonu yeni Claude session'ında yap."** Antigravity zaten ayrı süreç; ek izolasyonun getirisi yok. Team Lead'i her delegasyon için yeni session'a taşımak ise baseline/kontrat devrini dosyaya yazmayı zorunlu kılar, sabit yükü (rules, agent tanımları, MCP şemaları) her seferinde taze tokenla ödetir ve Codex'te karşılığı yoktur. Net fayda belirsiz, karmaşıklık kesin.

**F. Otomatik `/clear` skill'i.** Teknik olarak mümkün değil; feature isteği kapalı.

**G. Her tool çağrısında agresif tool-result clearing.** Anthropic'in kendi mekanizması zaten devrede; üstüne hook ile ek kırpma, Team Lead'in diff okumasını bozabilir. Sadece test çıktısı için (D) yeterli.

### Dürüst özet

AEO'nun asıl tasarrufu zaten mimariden geliyor: implementation context'i pahalı modelden tamamen çıkarılmış durumda. "Context temizleme" eklemeleri bunun üstüne ikinci dereceden bir kazanç: Team Lead penceresinin daha yavaş dolması, daha az auto-compact, daha az kayıp baseline. Toplam token azalması esas olarak A'dan gelir (raporu dışarı almak); B, C, D kaliteyi korur, tokeni çok az etkiler. Bunların hiçbiri ölçülmeden "yüzde X tasarruf" iddia edilmemeli; README zaten bu dürüstlük ilkesini koyuyor.

## 4. Ölçüm planı: AEO varken / yokken

### Ne ölçeceğiz

| Metrik | Kaynak | Neden |
| --- | --- | --- |
| Team Lead input / cache_creation / cache_read / output token | `~/.claude/projects/<proje>/<session>.jsonl` içindeki `usage` alanı. Her asistan mesajında var (bu oturumda doğrulandı). Codex için `~/.codex/sessions` eşdeğeri. | Pahalı modelin gerçek tüketimi. Cache ayrımı şart, çünkü fiyat farkı 10x. |
| Mühendis (Gemini) token | Bridge'in `Execution metadata` içindeki `usage` alanı (CLI gönderdiğinde). | Ucuz tarafın tüketimi; toplam maliyet için gerekli. |
| Auto-compact sayısı | `PreCompact` hook ile sayaç dosyasına satır ekle. | Context baskısının doğrudan göstergesi. |
| Duvar saati süresi | Session başlangıç/bitiş zaman damgası. | Delegasyonun gecikme maliyeti. |
| Görev başarısı | Görevin gizli kabul testleri (aşağıda). | Token tasarrufu başarısız işte anlamsız. |
| Revizyon sayısı | Delegasyon çağrısı sayısı. | Kalite döngüsünün maliyeti. |
| Kirli dosya ihlali | Baseline'daki kullanıcı dosyaları değişti mi. | AEO'nun sahiplik kuralının çalışıp çalışmadığı. |

Maliyete çevirme: kullanıcının kendi fiyat tablosu (`cost-aware-routing.md`'deki ilkeye uygun, sağlayıcıdan bağımsız). Tabloya iki sütun: liste fiyatı ve kullanıcının plan fiyatı.

### Koşullar

- **K0:** Düz Claude Code, AEO kurulu değil. Aynı prompt.
- **K1:** AEO mevcut sürüm (v1.3.0).
- **K2:** AEO + bölüm 3'teki A-D değişiklikleri.

K0 ile K1 farkı "AEO'nun faydası", K1 ile K2 farkı "context hijyeninin faydası". İkisini ayrı ayrı raporlamak gerekir; birleştirilirse hangi değişikliğin işe yaradığı görülmez.

### Görev seti

Sabit bir açık kaynak depo, pinlenmiş commit. Beş görev, her biri gerçek bir geçmiş commit'ten türetilmiş:

1. Davranışsal bug fix (commit geri alınır, kullanıcı belirtileri anlatır; commit'in testleri gizli kabul testi olur).
2. Küçük özellik (yeni bir parametre + test).
3. Çok dosyalı refactor (davranış sabit, testler değişmez).
4. Trivial düzeltme (typo + yorum). Bu görev AEO'nun "ceremony" maliyetini ölçer; AEO'nun burada daha pahalı çıkması beklenir ve bu dürüstçe raporlanır.
5. Önceden kirli çalışma ağacı ile bug fix (baseline kuralını test eder).

Prompt'lar `examples/smoke-test.md` Test B tarzında: rol ve tool adı geçmeyen, doğal istek.

### Tekrar ve istatistik

Her görev × koşul en az 3 koşu (model belirsizliği yüksek). Medyan ve aralık raporlanır, ortalama değil. Her koşu temiz bir session'da (`/clear` değil, yeni session) ve aynı sıcaklıkta cache ile başlar; ilk koşu cache ısıtması olarak sayılmaz, çünkü gerçek kullanımda da soğuk başlar.

### Araç

Depoya `scripts/bench/` altında küçük bir Node aracı:

- `collect-claude-usage.mjs <session.jsonl>`: usage alanlarını toplar, JSON döker.
- `collect-bridge-usage.mjs`: bridge'in run log'undan Gemini usage toplar. Bunun için bridge'e opsiyonel `AEO_RUN_LOG=<dosya>` desteği gerekir (bölüm 3-A ile aynı delegasyonda yapılabilir).
- `report.mjs`: koşuları tablo + CSV olarak birleştirir.

Topluluk aracı `ccusage` da aynı jsonl'leri okur; ilk tur için yeterli olabilir, ama bridge tarafını görmez.

### Kontrol edilmesi gereken yanıltıcılar

- Model sürümü değişirse seri yeniden başlar; tarihi ve model ID'lerini tabloya yaz.
- Kota fallback'i (Flash'a düşme) koşuyu farklı modele taşır; bridge metadata'sındaki model alanıyla filtrele.
- `/compact` manuel tetiklenmez; koşu boyunca sadece auto-compact.
- Team Lead'in kendisi kodu yazarsa (politika ihlali) koşu "geçersiz" olarak işaretlenir, atılmaz; ihlal oranı da bir sonuçtur.

### Başarı ölçütü

K1'in K0'a göre Team Lead taze+output tokenini görev 1-3 ve 5'te düşürmesi, görev başarı oranını düşürmemesi. Görev 4'te daha pahalı olması kabul edilir ve belgelenir. K2'nin K1'e göre delegasyon başına Team Lead input tokenini düşürmesi ve auto-compact sayısını azaltması. Sayılar README'ye "bu ortamda, bu tarihte, bu görev setinde" notuyla girer; genel tasarruf iddiası olarak girmez.

## Kaynaklar

- Claude Code docs: [context window](https://code.claude.com/docs/en/context-window), [subagents](https://code.claude.com/docs/en/sub-agents), [costs](https://code.claude.com/docs/en/costs), [skills](https://code.claude.com/docs/en/skills), [hooks](https://code.claude.com/docs/en/hooks)
- [anthropics/claude-code#45091](https://github.com/anthropics/claude-code/issues/45091), skill'lerin context temizlemesi isteği (kapalı, #37307'nin kopyası)
- [Anthropic cookbook: automatic context compaction](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction)
- [Justin Fuller: sub-agents ve auto-compact](https://justindfuller.com/programming/claude-tip-context-conservation)
- [jsmanifest, DEV: context window management 2026](https://dev.to/jsmanifest/claude-code-context-window-management-in-2026-what-gets-included-what-gets-dropped-and-how-to-26kh) (üçüncü taraf, sayıları doğrulanmamış)
