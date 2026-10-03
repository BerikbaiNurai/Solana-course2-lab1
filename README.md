# LeafSwap — Constant-Product AMM on Solana Devnet

Учебный DeFi-MVP: **AMM** (формула \(x \cdot y = k\)) на Solana **Devnet**.  
Mainnet и реальные средства не используются.

| | |
|---|---|
| **Механика** | Constant-product AMM: add/remove liquidity, swap |
| **Program ID** | `3mmojyB5aYhqo1VXBYmE3tfUQfTuFkwfnHK4KZ1v66PK` |
| **Кластер** | Devnet |
| **Токены** | SPL Token (Token Program) |
| **Комиссия** | 30 bps (0.30%), максимум конфигурации 100 bps |

> После деплоя добавьте сюда ссылки на успешные транзакции Explorer и URL демо.

---

## 1. Задача

Реализован минимальный AMM-пул:

1. **Initialize** — создание пула (PDA), LP-mint, vault ATA.
2. **Add liquidity** — депозит двух SPL-токенов, выпуск LP-долей.
3. **Remove liquidity** — сжигание LP, вывод пропорциональных резервов.
4. **Swap** — обмен exact-in с комиссией и защитой slippage (`min_out`).

---

## 2. Архитектура

```
┌──────────────┐     wallet tx      ┌─────────────────────┐
│  React UI    │ ─────────────────► │  AMM program (BPF)   │
│  (Vite)      │ ◄── statuses/err ─ │  PDA Pool + vaults  │
└──────────────┘                    └──────────┬──────────┘
                                               │ CPI
                                    ┌──────────▼──────────┐
                                    │  SPL Token Program  │
                                    │  vault_a / vault_b  │
                                    │  lp_mint / lp_lock  │
                                    └─────────────────────┘
```

### Аккаунты и PDA

| Аккаунт | Seeds / тип | Назначение |
|---------|-------------|------------|
| `Pool` | PDA `["pool", mint_a, mint_b]` | Состояние пула: mint’ы, vault’ы, fee, bump |
| `lp_mint` | PDA `["lp_mint", pool]` | Mint LP-токенов, authority = Pool PDA |
| `vault_a` / `vault_b` | ATA(pool, mint_a/b) | Резервы токенов, owner = Pool PDA |
| `lp_lock` | ATA(pool, lp_mint) | Навсегда удерживает `MINIMUM_LIQUIDITY` |

Инструкции проверяют: **signer**, владельцев token-аккаунтов, mint, соответствие vault ↔ pool (`has_one` + constraints), ненулевые суммы, slippage, потолок комиссии.

---

## 3. Экономическая модель

- **Инвариант:** \(k = x \cdot y\) (после свопа с учётом fee \(k\) не уменьшается).
- **Комиссия:** с входа, `fee_bps / 10_000` (по умолчанию 0.30%).
- **Выход свопа:**
  \[
  amount\_out = \frac{amount\_in\_less\_fee \cdot reserve\_out}{reserve\_in + amount\_in\_less\_fee}
  \]
- **Первая ликвидность:** \(L = \sqrt{x \cdot y} - MINIMUM\_LIQUIDITY\), где `MINIMUM_LIQUIDITY = 1000` лочится в `lp_lock` (защита от пустого пула / манипуляций долей).
- **Последующие депозиты:** \(L = \min(amount_a \cdot supply / reserve_a,\ amount_b \cdot supply / reserve_b)\).
- **Вывод:** пропорционально доле LP от резервов.
- Арифметика — только `checked_*` / `u128` промежуточные значения (`overflow-checks = true` в release).

### Риски (учебный MVP)

| Риск | Статус |
|------|--------|
| Impermanent loss | Присущ AMM; не страхуется |
| Манипуляция ценой в тонком пуле | Демо-ликвидность мала — ожидаемо |
| Оракулы | Нет (цена только из пула) |
| Admin / upgrade authority | Учебный деплой; для mainnet нужен multisig + timelock |
| MEV / sandwich | Нет private mempool / TWAP |
| LP fee accounting | Fee остаётся в резервах (как Uniswap V2) |

---

## 4. Безопасность

- Нет приватных ключей в репозитории (`.gitignore`: `id.json`, `.env`, `target/`).
- Проверки mint / owner / PDA bump / slippage / zero amounts / max fee / identical mints.
- Средства пользователей хранятся только в PDA-vaults; вывод — через инструкцию `remove_liquidity` / `swap` с signer.
- Негативные тесты: нулевой swap, невозможный slippage, identical mints, fee > max.

**Критические анти-паттерны, которых избегаем:** произвольный withdraw authority, отсутствие проверки mint, unchecked math, хардкод секретов.

---

## 5. Структура репозитория

```
programs/amm/src/lib.rs   — on-chain программа (Anchor 0.30)
tests/amm.ts              — ≥5 автотестов (вкл. негативные)
app/                      — Vite + React + wallet-adapter
scripts/setup-devnet.ts   — mint’ы и config для Devnet
deployments/              — артефакты деплоя (без секретов)
```

---

## 6. Требования

- Node.js 20+
- Rust stable
- Solana CLI ≥ 1.18 / 2.x (`cargo-build-sbf`)
- Anchor CLI **0.30.1**
- (Windows) рекомендуется **Docker** или WSL — нативная сборка SBF на Windows нестабильна

### Быстрый путь через Docker (Windows)

```bash
# один раз собрать образ (долго)
docker build -f Dockerfile.build -t solana-amm-builder:0.30.1 .

# сборка программы
docker run --rm -v ${PWD}:/work -w /work solana-amm-builder:0.30.1 bash -lc "anchor build"

# тесты (localnet внутри контейнера)
docker run --rm -v ${PWD}:/work -w /work solana-amm-builder:0.30.1 bash -lc "anchor test"
```

### Локально (Linux / WSL / macOS)

```bash
avm install 0.30.1 && avm use 0.30.1
yarn install   # или npm install в корне
anchor build
anchor test
```

### Фронтенд

```bash
cd app
npm install
npm run dev
```

Откройте http://localhost:5173, кошелёк на **Devnet**, импортируйте demo-токены после `setup:devnet`.

### Devnet деплой

```bash
solana config set --url https://api.devnet.solana.com
solana airdrop 2   # или faucet.solana.com
anchor deploy --provider.cluster devnet

# создать demo SPL mint’ы и прописать config UI
npm install
npx ts-node scripts/setup-devnet.ts
```

Зафиксируйте Program ID и подписи транзакций в `deployments/devnet.json` и в этом README.

---

## 7. Тесты

```bash
anchor test
```

Сценарии в `tests/amm.ts`:

1. Initialize pool  
2. Add liquidity (+ lock minimum LP)  
3. Swap A→B  
4. Remove liquidity  
5. **Neg:** zero-amount swap  
6. **Neg:** slippage too tight  
7. **Neg:** identical mints  
8. **Neg:** fee above max  

---

## 8. Демо и сдача

- **GitHub:** _(добавьте публичный URL после push)_  
- **Demo UI / видео 3–5 мин:** _(URL)_  
- **Program ID:** `3mmojyB5aYhqo1VXBYmE3tfUQfTuFkwfnHK4KZ1v66PK`  
- **Explorer (примеры tx):** _(вставить после прогона)_  
  - Initialize: `https://explorer.solana.com/tx/<SIG>?cluster=devnet`  
  - Add liquidity: …  
  - Swap: …  

---

## 9. Ограничения MVP и что улучшить перед mainnet

1. Один пул на упорядоченную пару mint’ов; нет router / multi-hop.  
2. Нет TWAP-оракула, circuit breaker, pause.  
3. Нет аудита, formal verification, bug bounty.  
4. Fee неизменяема после init (для mainnet — governance).  
5. Upgrade authority должна быть у multisig + timelock либо программа immutable.  
6. Добавить property-тесты математики, fuzz CPI, симуляции IL.  
7. Индексатор событий + мониторинг резервов.  
8. Token-2022 / transfer hooks — отдельная поддержка.

---

## 10. Лицензия

Учебный проект. Код предоставляется as-is для Devnet.
# Solana-course2-lab1
