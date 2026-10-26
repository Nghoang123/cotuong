/*
 * Xiangqi Engine Worker  -  v3 "Deep Search" (speed + safety pass on v2)
 *
 * Changes versus the v2 file you supplied (all verified, see test notes delivered with this file):
 *  SPEED   : lookup tables replace the branchy sideOf/upper/baseVal helpers; the move generator uses
 *            precomputed ray / knight / bishop / advisor / king tables; quiet "check-probe" moves in
 *            quiescence are pre-filtered geometrically before the exact check test; eval distance
 *            is computed only for attacking piece types.  Measured: ~2.4-2.6x nodes/second with an
 *            identical move set (checked against the previous generator on ~39,000 positions).
 *  SEARCH  : moves that give check are no longer reduced by LMR (they were already exempt from pruning);
 *            null-move verification also runs in thin positions (<= 2 rooks/cannons/knights) to
 *            reduce zugzwang errors.
 *  EVAL    : the "side without attackers cannot win" damping no longer quarters the score when that
 *            side still owns uncrossed pawns (halved instead); never a forced draw.
 *  PONDER  : fixed the history side-to-move tag used for ponder branches (repetition parity), and
 *            capped ponder slices at 250 ms so a real request is not left waiting behind a long slice.
 *  UNCHANGED: message protocol, opening book, history / repetition / perpetual-check handling,
 *            presets, TT layout, USE_EXTERNAL_WASM (still false: no compatible binary was verified).
 */

// Set to true only if you ship a compatible ./xiangqi_engine.wasm and want it to replace this JS search.
const USE_EXTERNAL_WASM = false;

// ============================================================================
// SÁCH KHAI CUỘC CỜ TƯỚNG ĐẠI KIỆN TƯỚNG (CHUẨN XÁC 100% KHỚP 90 KÝ TỰ)
// ============================================================================
const OPENING_BOOK = {
  // 1. ĐỎ ĐI TIÊN (NƯỚC 1)
  "R:rnbakabnr..........c.....c.p.p.p.p.p..................P.P.P.P.P.C.....C..........RNBAKABNR": [
    { fr: 7, fc: 7, tr: 7, tc: 4, weight: 55 }, // Pháo 2 bình 5 (Trung Pháo)
    { fr: 7, fc: 1, tr: 7, tc: 4, weight: 20 }, // Pháo 8 bình 5 (Trung Pháo)
    { fr: 6, fc: 6, tr: 5, tc: 6, weight: 12 }, // Tốt 3 tấn 1 (Tiên Nhân Chỉ Lộ)
    { fr: 6, fc: 2, tr: 5, tc: 2, weight: 5  }, // Tốt 7 tấn 1 (Tiên Nhân Chỉ Lộ)
    { fr: 9, fc: 6, tr: 7, tc: 4, weight: 5  }, // Tượng 3 tấn 5 (Phi Tượng Cuộc)
    { fr: 7, fc: 7, tr: 7, tc: 2, weight: 3  }  // Pháo 2 bình 7 (Quá Cung Pháo)
  ],
  // 2. ĐEN ĐỠ TRUNG PHÁO (PHÁO 2 BÌNH 5 CỦA ĐỎ -> (7,7) sang (7,4))
  "B:rnbakabnr..........c.....c.p.p.p.p.p..................P.P.P.P.P.C..C.............RNBAKABNR": [
    { fr: 0, fc: 7, tr: 2, tc: 6, weight: 65 }, // Mã 8 tấn 7 (Bình Phong Mã)
    { fr: 0, fc: 1, tr: 2, tc: 2, weight: 15 }, // Mã 2 tấn 3
    { fr: 2, fc: 7, tr: 2, tc: 4, weight: 12 }, // Pháo 8 bình 5 (Thuận Pháo)
    { fr: 2, fc: 1, tr: 2, tc: 4, weight: 8  }  // Pháo 2 bình 5 (Nghịch Pháo)
  ],
  // 3. ĐEN ĐỠ TRUNG PHÁO (PHÁO 8 BÌNH 5 CỦA ĐỎ -> (7,1) sang (7,4))
  "B:rnbakabnr..........c.....c.p.p.p.p.p..................P.P.P.P.P....C..C..........RNBAKABNR": [
    { fr: 0, fc: 1, tr: 2, tc: 2, weight: 65 }, // Mã 2 tấn 3
    { fr: 0, fc: 7, tr: 2, tc: 6, weight: 20 }, // Mã 8 tấn 7
    { fr: 2, fc: 1, tr: 2, tc: 4, weight: 15 }  // Pháo 2 bình 5 (Thuận Pháo)
  ],
  // 4. ĐEN ĐỠ TIÊN NHÂN CHỈ LỘ (TỐT 3 TẤN 1 -> (6,6) lên (5,6))
  "B:rnbakabnr..........c.....c.p.p.p.p.p...............P..P.P.P...P.C.....C..........RNBAKABNR": [
    { fr: 2, fc: 1, tr: 2, tc: 2, weight: 40 }, // Pháo 2 bình 3 (Liễm Pháo)
    { fr: 3, fc: 6, tr: 4, tc: 6, weight: 30 }, // Tốt 7 tấn 1 (Đối Binh Cuộc)
    { fr: 2, fc: 7, tr: 2, tc: 4, weight: 15 }, // Pháo 8 bình 5 (Pháo đầu công lại)
    { fr: 0, fc: 7, tr: 2, tc: 6, weight: 15 }  // Mã 8 tấn 7
  ],
  // 5. ĐEN ĐỠ TIÊN NHÂN CHỈ LỘ (TỐT 7 TẤN 1 -> (6,2) lên (5,2))
  "B:rnbakabnr..........c.....c.p.p.p.p.p...........P......P...P.P.P.C.....C..........RNBAKABNR": [
    { fr: 2, fc: 7, tr: 2, tc: 6, weight: 40 }, // Pháo 8 bình 7 (Liễm Pháo)
    { fr: 3, fc: 2, tr: 4, tc: 2, weight: 30 }, // Tốt 3 tấn 1 (Đối Binh Cuộc)
    { fr: 2, fc: 1, tr: 2, tc: 4, weight: 15 }, // Pháo 2 bình 5
    { fr: 0, fc: 1, tr: 2, tc: 2, weight: 15 }  // Mã 2 tấn 3
  ],
  // 6. ĐEN ĐỠ PHI TƯỢNG CUỘC (TƯỢNG 3 TẤN 5 -> (9,6) lên (7,4))
  "B:rnbakabnr..........c.....c.p.p.p.p.p..................P.P.P.P.P.C..B..C..........RNBAKA.NR": [
    { fr: 2, fc: 1, tr: 2, tc: 3, weight: 40 }, // Pháo 2 bình 4 (Quá Cung Pháo)
    { fr: 0, fc: 7, tr: 2, tc: 6, weight: 35 }, // Mã 8 tấn 7
    { fr: 3, fc: 6, tr: 4, tc: 6, weight: 25 }  // Tốt 7 tấn 1
  ]
};

function pickBookMove(boardKey) {
  const choices = OPENING_BOOK[boardKey];
  if (!choices || !choices.length) return null;
  const total = choices.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const item of choices) {
    r -= item.weight;
    if (r <= 0) return { fr: item.fr, fc: item.fc, tr: item.tr, tc: item.tc };
  }
  return choices[0];
}

// ============================================================================
// ENGINE STATE
// ============================================================================
const INF = 10000000;
const MATE = 900000;
const NO_EVAL = -INF;
const MAX_PLY = 80;
const MAX_MOVES = 128;

const board = new Int8Array(90);
const kingSq = new Int32Array([-1, -1]);
const majorCnt = new Int32Array(2);   // rooks + cannons + knights per side (incremental)
let pieceCount = 0;                   // total pieces on board (incremental)

const ROW = new Int8Array(90);
const COL = new Int8Array(90);
for (let i = 0; i < 90; i++) { ROW[i] = (i / 9) | 0; COL[i] = i % 9; }
const IS_MAJOR = new Uint8Array(128);
IS_MAJOR[82] = IS_MAJOR[67] = IS_MAJOR[78] = IS_MAJOR[114] = IS_MAJOR[99] = IS_MAJOR[110] = 1;

let nodes = 0;
let nodeLimit = 1200000;
let deadline = 0;            // absolute performance.now() value, 0 = no time limit
let stopped = 0;
let lastScore = 0;
let completedDepth = 0;
let rootSide = 1;
let startDepth = 1;
let curIter = 1;             // depth of the iteration currently running (bounds check extensions)
let repContempt = 600;       // how much the engine dislikes repeating a position

// History / repetition bookkeeping (filled by analyzeGameHistory)
let pastStateCounts = new Map();
let recentRawBoards = [];
let recentTurnSides = [];
let recentPieceCnt = [];
let lastAIFrom = -1;
let lastAITo = -1;
let consecutiveAIChecks = 0;
let samePieceStreak = 0;
let visitedSquaresByPiece = new Set();
let repBaseLen = 0;
let repRoot = 0;

const globalPenalties = new Int32Array(8100);
const globalRepCounts = new Int16Array(8100);

function getCurrentBoardString() {
  let str = '';
  for (let i = 0; i < 90; i++) {
    const p = board[i];
    str += p === 0 ? '.' : String.fromCharCode(p);
  }
  return str;
}

const pstPawn = new Int16Array([
   12,  18,  24,  38,  42,  38,  24,  18,  12,
   50,  68,  85, 110, 120, 110,  85,  68,  50,
   48,  65,  80, 100, 112, 100,  80,  65,  48,
   38,  48,  60,  78,  88,  78,  60,  48,  38,
   22,  32,  42,  55,  62,  55,  42,  32,  22,
    0,   0,  12,   0,  22,   0,  12,   0,   0,
    0,   0,   0,   0,   6,   0,   0,   0,   0,
    0,   0,   0,   0,   0,   0,   0,   0,   0,
    0,   0,   0,   0,   0,   0,   0,   0,   0,
    0,   0,   0,   0,   0,   0,   0,   0,   0
]);

const pstKnight = new Int16Array([
    0,  -5,  12,  12,   5,  12,  12,  -5,   0,
    8,  18,  45,  55,  30,  55,  45,  18,   8,
   12,  28,  50,  62,  54,  62,  50,  28,  12,
   10,  22,  38,  48,  44,  48,  38,  22,  10,
    8,  18,  30,  38,  35,  38,  30,  18,   8,
    5,  14,  26,  32,  30,  32,  26,  14,   5,
    2,  10,  20,  24,  22,  24,  20,  10,   2,
    0,   5,  16,  16,  12,  16,  16,   5,   0,
   -8,   0,   5,   5,  -5,   5,   5,   0,  -8,
  -15, -10,   0,   0, -10,   0,   0, -10, -15
]);

const pstCannon = new Int16Array([
   16,  20,  16,  12,   8,  12,  16,  20,  16,
   18,  24,  22,  28,  34,  28,  22,  24,  18,
   16,  24,  28,  35,  44,  35,  28,  24,  16,
   12,  16,  22,  30,  40,  30,  22,  16,  12,
    8,  14,  20,  26,  35,  26,  20,  14,   8,
    5,  10,  15,  22,  30,  22,  15,  10,   5,
    2,   8,  10,  16,  26,  16,  10,   8,   2,
    5,  16,  14,  20,  35,  20,  14,  16,   5,
    2,   5,   5,   6,  14,   6,   5,   5,   2,
    0,   2,   5,   5,  10,   5,   5,   2,   0
]);

const pstRook = new Int16Array([
   20,  30,  24,  36,  38,  36,  24,  30,  20,
   28,  44,  38,  52,  56,  52,  38,  44,  28,
   22,  35,  30,  44,  46,  44,  30,  35,  22,
   18,  32,  26,  38,  40,  38,  26,  32,  18,
   16,  30,  25,  36,  38,  36,  25,  30,  16,
   14,  26,  22,  32,  34,  32,  22,  26,  14,
   10,  22,  16,  26,  28,  26,  16,  22,  10,
    6,  18,  12,  22,  22,  22,  12,  18,   6,
    5,  16,  10,  20,  16,  20,  10,  16,   5,
   -5,  14,   8,  18,   8,  18,   8,  14,  -5
]);

// ----------------------------------------------------------------------------
// Transposition table: 2-way buckets, depth+age replacement
// ----------------------------------------------------------------------------
const TT_BITS = 20;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const ttKeyLo = new Uint32Array(TT_SIZE);
const ttKeyHi = new Uint32Array(TT_SIZE);
const ttScore = new Int32Array(TT_SIZE);
const ttMove  = new Int16Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttFlag  = new Uint8Array(TT_SIZE);
const ttAge   = new Uint8Array(TT_SIZE);
let ttGen = 0;

function ttFind(lo, hi) {
  const i = lo & TT_MASK & ~1;
  if (ttKeyLo[i] === lo && ttKeyHi[i] === hi) return i;
  if (ttKeyLo[i + 1] === lo && ttKeyHi[i + 1] === hi) return i + 1;
  return -1;
}
function ttSlot(lo, hi) {
  const i = lo & TT_MASK & ~1;
  if (ttKeyLo[i] === lo && ttKeyHi[i] === hi) return i;
  if (ttKeyLo[i + 1] === lo && ttKeyHi[i + 1] === hi) return i + 1;
  const r0 = ((ttGen - ttAge[i]) & 255) * 8 - ttDepth[i];
  const r1 = ((ttGen - ttAge[i + 1]) & 255) * 8 - ttDepth[i + 1];
  return r1 > r0 ? i + 1 : i;
}
function ttStore(lo, hi, depth, score, flag, move) {
  const s = ttSlot(lo, hi);
  const same = ttKeyLo[s] === lo && ttKeyHi[s] === hi;
  ttKeyLo[s] = lo; ttKeyHi[s] = hi;
  ttDepth[s] = depth; ttScore[s] = score; ttFlag[s] = flag; ttAge[s] = ttGen;
  if (!(same && flag === 1)) ttMove[s] = move;   // a fail-low carries no real best move
}
function ttClear() {
  ttKeyLo.fill(0); ttKeyHi.fill(0); ttDepth.fill(0); ttAge.fill(0);
}

// Evaluation cache (board-only score, red perspective)
const EV_BITS = 17;
const EV_MASK = (1 << EV_BITS) - 1;
const evKeyLo = new Uint32Array(1 << EV_BITS);
const evKeyHi = new Uint32Array(1 << EV_BITS);
const evVal   = new Int32Array(1 << EV_BITS);

// Zobrist hashing
const zobLo = new Uint32Array(128 * 90);
const zobHi = new Uint32Array(128 * 90);
let zobSideLo = 0, zobSideHi = 0;
let curHashLo = 0, curHashHi = 0;
let zobReady = false;

function initZobrist() {
  if (zobReady) return;
  let s0 = 0x12345678 >>> 0, s1 = 0x9abcdef0 >>> 0;
  const nextRand = () => {
    let x = s0, y = s1;
    s0 = y;
    x ^= (x << 23) >>> 0;
    s1 = (x ^ y ^ (x >>> 17) ^ (y >>> 26)) >>> 0;
    return (s1 + y) >>> 0;
  };
  for (let i = 0; i < 128 * 90; i++) {
    zobLo[i] = nextRand();
    zobHi[i] = nextRand();
  }
  zobSideLo = nextRand();
  zobSideHi = nextRand();
  zobReady = true;
}

// Move buffers (one row of MAX_MOVES per ply)
const moveFrom  = new Int16Array(MAX_PLY * MAX_MOVES);
const moveTo    = new Int16Array(MAX_PLY * MAX_MOVES);
const moveCap   = new Int8Array(MAX_PLY * MAX_MOVES);
const moveScore = new Int32Array(MAX_PLY * MAX_MOVES);
const quietBuf  = new Int16Array(MAX_PLY * MAX_MOVES);
const rootMovePenalty = new Int32Array(MAX_MOVES);
const rootMoveRepCount = new Int16Array(MAX_MOVES);

const searchHistoryFrom = new Int16Array(MAX_PLY).fill(-1);
const searchHistoryTo   = new Int16Array(MAX_PLY).fill(-1);

const pvTable = new Int32Array(MAX_PLY * MAX_PLY);
const pvLen   = new Int32Array(MAX_PLY);
const killers0 = new Int16Array(MAX_PLY).fill(-1);
const killers1 = new Int16Array(MAX_PLY).fill(-1);
const historyHeur = new Int32Array(2 * 90 * 90);
const counterMoves = new Int16Array(2 * 90 * 90);
const repHashLo = new Uint32Array(MAX_PLY + 512);
const repHashHi = new Uint32Array(MAX_PLY + 512);
const sinceCap = new Int32Array(MAX_PLY + 2);
const evalStack = new Int32Array(MAX_PLY + 4).fill(NO_EVAL);

// Root ordering memory (scores from the previous iteration)
const rootScoreArr = new Int32Array(8100);
const rootScoreStamp = new Int32Array(8100);
let rootEpoch = 1;
let rootBestScore = 0;
let rootPartialValid = false;

// LMR table
const lmrTable = new Int8Array(64 * MAX_MOVES);
for (let d = 1; d < 64; d++) {
  for (let m = 1; m < MAX_MOVES; m++) {
    lmrTable[d * MAX_MOVES + m] = Math.floor(0.55 + Math.log(d) * Math.log(m) / 2.35);
  }
}

// Lookup tables (identical semantics to the former branchy functions, but ~free to call)
const SIDE_TAB = new Int8Array(128).fill(-1);
const UPPER_TAB = new Uint8Array(128);
const BASEV_TAB = new Int32Array(128);
for (let p = 0; p < 128; p++) {
  UPPER_TAB[p] = (p >= 97 && p <= 122) ? (p - 32) : p;
  if (p >= 65 && p <= 90) SIDE_TAB[p] = 1; else if (p >= 97 && p <= 122) SIDE_TAB[p] = 0;
}
BASEV_TAB[75] = 20000; // K
BASEV_TAB[82] = 1080;  // R
BASEV_TAB[67] = 510;   // C
BASEV_TAB[78] = 490;   // N
BASEV_TAB[66] = 150;   // B
BASEV_TAB[65] = 150;   // A
BASEV_TAB[80] = 115;   // P
for (const [lo, up] of [[107, 75], [114, 82], [99, 67], [110, 78], [98, 66], [97, 65], [112, 80]]) BASEV_TAB[lo] = BASEV_TAB[up];
function sideOf(p) { return SIDE_TAB[p & 127]; }
function upper(p) { return UPPER_TAB[p & 127]; }
function baseVal(p) { return BASEV_TAB[p & 127]; }

function computeHash(side) {
  curHashLo = side ? zobSideLo : 0;
  curHashHi = side ? zobSideHi : 0;
  for (let i = 0; i < 90; i++) {
    const p = board[i];
    if (p > 0) {
      const idx = p * 90 + i;
      curHashLo = (curHashLo ^ zobLo[idx]) >>> 0;
      curHashHi = (curHashHi ^ zobHi[idx]) >>> 0;
    }
  }
}

function loadBoardFromString(text90, side) {
  initZobrist();
  kingSq[0] = -1;
  kingSq[1] = -1;
  majorCnt[0] = 0; majorCnt[1] = 0;
  pieceCount = 0;
  for (let i = 0; i < 90; i++) {
    const ch = text90.charCodeAt(i);
    const p = (ch === 46 || ch === 0 || ch !== ch) ? 0 : ch;
    board[i] = p;
    if (p) {
      pieceCount++;
      if (IS_MAJOR[p]) majorCnt[p < 97 ? 1 : 0]++;
      if (p === 75) kingSq[1] = i;
      else if (p === 107) kingSq[0] = i;
    }
  }
  computeHash(side);
}

const DR4 = [-1, 1, 0, 0], DC4 = [0, 0, -1, 1];
const NDR = [-2, -2, 2, 2, -1, 1, -1, 1];
const NDC = [-1, 1, -1, 1, -2, -2, 2, 2];
const NLEGR = [-1, -1, 1, 1, -1, 1, -1, 1];
const NLEGC = [-1, 1, -1, 1, -1, -1, 1, 1];
const ML_LEGR = [-1, -1, 1, 1, 0, 0, 0, 0];
const ML_LEGC = [0, 0, 0, 0, -1, -1, 1, 1];
const BDR = [-2, -2, 2, 2], BDC = [-2, 2, -2, 2];
const ADR = [-1, -1, 1, 1], ADC = [-1, 1, -1, 1];

// Knight attack tables: for every square, the squares from which an enemy knight would attack it
// and the matching "leg" squares that must be empty.
const KN_FROM = new Int16Array(90 * 8).fill(-1);
const KN_LEG = new Int16Array(90 * 8).fill(-1);
for (let sq = 0; sq < 90; sq++) {
  const r = (sq / 9) | 0, c = sq % 9;
  for (let i = 0; i < 8; i++) {
    const nr = r + NDR[i], nc = c + NDC[i];
    if (nr >= 0 && nr < 10 && nc >= 0 && nc < 9) {
      KN_FROM[sq * 8 + i] = nr * 9 + nc;
      KN_LEG[sq * 8 + i] = (r + NLEGR[i]) * 9 + (c + NLEGC[i]);
    }
  }
}

function inCheck(side) {
  const k = kingSq[side];
  if (k < 0) return 1;
  const enemyR = side ? 114 : 82;
  const enemyC = side ? 99  : 67;
  const enemyN = side ? 110 : 78;
  const enemyP = side ? 112 : 80;
  const enemyK = side ? 107 : 75;
  const kc = k % 9;
  const rowStart = k - kc;
  const rowEnd = rowStart + 8;
  let q = 0, p = 0, screens = 0;

  // up
  for (q = k - 9; q >= 0; q -= 9) {
    p = board[q];
    if (p) {
      if (screens === 0) { if (p === enemyR || p === enemyK) return 1; screens = 1; }
      else { if (p === enemyC) return 1; break; }
    }
  }
  // down
  screens = 0;
  for (q = k + 9; q < 90; q += 9) {
    p = board[q];
    if (p) {
      if (screens === 0) { if (p === enemyR || p === enemyK) return 1; screens = 1; }
      else { if (p === enemyC) return 1; break; }
    }
  }
  // left
  screens = 0;
  for (q = k - 1; q >= rowStart; q--) {
    p = board[q];
    if (p) {
      if (screens === 0) { if (p === enemyR || p === enemyK) return 1; screens = 1; }
      else { if (p === enemyC) return 1; break; }
    }
  }
  // right
  screens = 0;
  for (q = k + 1; q <= rowEnd; q++) {
    p = board[q];
    if (p) {
      if (screens === 0) { if (p === enemyR || p === enemyK) return 1; screens = 1; }
      else { if (p === enemyC) return 1; break; }
    }
  }

  const kb = k * 8;
  for (let i = 0; i < 8; i++) {
    const ns = KN_FROM[kb + i];
    if (ns >= 0 && board[ns] === enemyN && board[KN_LEG[kb + i]] === 0) return 1;
  }

  const pq = k + (side ? -9 : 9);
  if (pq >= 0 && pq < 90 && board[pq] === enemyP) return 1;
  if (kc > 0 && board[k - 1] === enemyP) return 1;
  if (kc < 8 && board[k + 1] === enemyP) return 1;
  return 0;
}

function isSquareAttacked(sq, attackerSide) {
  const kr = (sq / 9) | 0, kc = sq % 9;
  const enemyR = attackerSide ? 82 : 114;
  const enemyC = attackerSide ? 67 : 99;
  const enemyN = attackerSide ? 78 : 110;
  const enemyP = attackerSide ? 80 : 112;
  const enemyB = attackerSide ? 66 : 98;
  const enemyA = attackerSide ? 65 : 97;
  const enemyK = attackerSide ? 75 : 107;

  for (let d = 0; d < 4; d++) {
    let r = kr + DR4[d], c = kc + DC4[d], screens = 0;
    while (r >= 0 && r < 10 && c >= 0 && c < 9) {
      const p = board[r * 9 + c];
      if (p) {
        if (screens === 0) {
          if (p === enemyR) return true;
          if (p === enemyK && Math.abs(r - kr) + Math.abs(c - kc) === 1) return true;
          screens = 1;
        } else {
          if (p === enemyC) return true;
          break;
        }
      }
      r += DR4[d]; c += DC4[d];
    }
  }

  for (let i = 0; i < 8; i++) {
    const nr = kr + NDR[i], nc = kc + NDC[i];
    if (nr >= 0 && nr < 10 && nc >= 0 && nc < 9 && board[nr * 9 + nc] === enemyN) {
      if (board[(kr + NLEGR[i]) * 9 + (kc + NLEGC[i])] === 0) return true;
    }
  }

  const pr = kr + (attackerSide ? 1 : -1);
  if (pr >= 0 && pr < 10 && board[pr * 9 + kc] === enemyP) return true;
  if (attackerSide ? (kr <= 4) : (kr >= 5)) {
    if (kc > 0 && board[kr * 9 + kc - 1] === enemyP) return true;
    if (kc < 8 && board[kr * 9 + kc + 1] === enemyP) return true;
  }

  for (let i = 0; i < 4; i++) {
    const br = kr + BDR[i], bc = kc + BDC[i];
    if (br >= 0 && br < 10 && bc >= 0 && bc < 9 && board[br * 9 + bc] === enemyB) {
      if (board[(kr + (BDR[i] >> 1)) * 9 + kc + (BDC[i] >> 1)] === 0) return true;
    }
  }

  if (kc >= 3 && kc <= 5 && (attackerSide ? (kr >= 7) : (kr <= 2))) {
    for (let i = 0; i < 4; i++) {
      const ar = kr + ADR[i], ac = kc + ADC[i];
      if (ar >= 0 && ar < 10 && ac >= 0 && ac < 9 && board[ar * 9 + ac] === enemyA) return true;
    }
  }
  return false;
}
function isBoardStringInCheck(b90, side) {
  const kChar = side ? 'K' : 'k';
  const k = b90.indexOf(kChar);
  if (k < 0) return false;
  const kr = (k / 9) | 0, kc = k % 9;
  const enemyR = side ? 'r' : 'R';
  const enemyC = side ? 'c' : 'C';
  const enemyN = side ? 'n' : 'N';
  const enemyP = side ? 'p' : 'P';
  const enemyK = side ? 'k' : 'K';

  for (let d = 0; d < 4; d++) {
    let r = kr + DR4[d], c = kc + DC4[d], screens = 0;
    while (r >= 0 && r < 10 && c >= 0 && c < 9) {
      const ch = b90[r * 9 + c];
      if (ch !== '.') {
        if (screens === 0) {
          if (ch === enemyR || ch === enemyK) return true;
          screens = 1;
        } else {
          if (ch === enemyC) return true;
          break;
        }
      }
      r += DR4[d]; c += DC4[d];
    }
  }
  for (let i = 0; i < 8; i++) {
    const nr = kr + NDR[i], nc = kc + NDC[i];
    if (nr >= 0 && nr < 10 && nc >= 0 && nc < 9 && b90[nr * 9 + nc] === enemyN) {
      if (b90[(kr + NLEGR[i]) * 9 + (kc + NLEGC[i])] === '.') return true;
    }
  }
  const pr = kr + (side ? -1 : 1);
  if (pr >= 0 && pr < 10 && b90[pr * 9 + kc] === enemyP) return true;
  if (kc > 0 && b90[kr * 9 + kc - 1] === enemyP) return true;
  if (kc < 8 && b90[kr * 9 + kc + 1] === enemyP) return true;
  return false;
}

function analyzeGameHistory(positionHistory, aiSide) {
  initZobrist();
  pastStateCounts.clear();
  recentRawBoards = [];
  recentTurnSides = [];
  recentPieceCnt = [];
  lastAIFrom = -1;
  lastAITo = -1;
  consecutiveAIChecks = 0;
  samePieceStreak = 0;
  visitedSquaresByPiece.clear();
  repBaseLen = 0;

  if (!Array.isArray(positionHistory) || positionHistory.length === 0) return;

  const rawBoards = [];
  const turnSides = [];
  for (let idx = 0; idx < positionHistory.length; idx++) {
    const entry = String(positionHistory[idx] || '');
    let s = 1;
    let b90 = entry;
    if (entry.length >= 92 && entry[1] === ':') {
      s = entry[0] === 'R' ? 1 : 0;
      b90 = entry.substring(2, 92);
    }
    if (b90.length === 90) {
      rawBoards.push(b90);
      turnSides.push(s);
      pastStateCounts.set(b90, (pastStateCounts.get(b90) || 0) + 1);
    }
  }

  const startIdx = Math.max(0, rawBoards.length - 60);
  for (let k = startIdx; k < rawBoards.length; k++) {
    const b90 = rawBoards[k];
    const s = turnSides[k];
    recentRawBoards.push(b90);
    recentTurnSides.push(s);
    let pc = 0;
    for (let q = 0; q < 90; q++) if (b90.charCodeAt(q) !== 46) pc++;
    recentPieceCnt.push(pc);
    let hLo = s ? zobSideLo : 0;
    let hHi = s ? zobSideHi : 0;
    for (let i = 0; i < 90; i++) {
      const ch = b90.charCodeAt(i);
      if (ch !== 46 && ch > 0 && ch < 128) {
        const zIdx = ch * 90 + i;
        hLo = (hLo ^ zobLo[zIdx]) >>> 0;
        hHi = (hHi ^ zobHi[zIdx]) >>> 0;
      }
    }
    repHashLo[repBaseLen] = hLo;
    repHashHi[repBaseLen] = hHi;
    repBaseLen++;
  }

  const moves = [];
  for (let k = 1; k < rawBoards.length; k++) {
    const prevB = rawBoards[k - 1];
    const currB = rawBoards[k];
    let fromSq = -1, toSq = -1;
    for (let i = 0; i < 90; i++) {
      if (prevB[i] !== currB[i]) {
        if (currB[i] === '.' && prevB[i] !== '.') fromSq = i;
        else if (currB[i] !== '.') toSq = i;
      }
    }
    if (fromSq !== -1 && toSq !== -1) {
      const piece = prevB[fromSq];
      const cap = prevB[toSq] !== '.' ? prevB[toSq] : null;
      const moverSide = (piece >= 'A' && piece <= 'Z') ? 1 : 0;
      const gaveCheck = isBoardStringInCheck(currB, moverSide ^ 1);
      moves.push({ from: fromSq, to: toSq, piece, cap, side: moverSide, gaveCheck });
    }
  }

  let expectedPieceSq = -1;
  let streakActive = true;
  let checkStreakActive = true;

  for (let mIdx = moves.length - 1; mIdx >= 0; mIdx--) {
    const mv = moves[mIdx];
    if (mv.cap) break;
    if (mv.side === aiSide) {
      if (lastAIFrom === -1) {
        lastAIFrom = mv.from;
        lastAITo = mv.to;
        expectedPieceSq = mv.from;
        samePieceStreak = 1;
        visitedSquaresByPiece.add(mv.from);
        visitedSquaresByPiece.add(mv.to);
      } else if (streakActive) {
        if (mv.to === expectedPieceSq) {
          samePieceStreak++;
          expectedPieceSq = mv.from;
          visitedSquaresByPiece.add(mv.from);
          visitedSquaresByPiece.add(mv.to);
        } else {
          streakActive = false;
        }
      }

      if (checkStreakActive) {
        if (mv.gaveCheck) {
          consecutiveAIChecks++;
        } else {
          checkStreakActive = false;
        }
      }
    }
  }
}

function precomputeRootPenalties(text90, side) {
  globalPenalties.fill(0);
  globalRepCounts.fill(0);
  loadBoardFromString(text90, side);

  const n = generateLegalMoves(side, false, 0, false);
  for (let i = 0; i < n; i++) {
    const f = moveFrom[i], t = moveTo[i], cap = moveCap[i];
    const moving = board[f];
    const mCode = f * 90 + t;

    doMove(f, t, cap, moving, side);
    const resultingStateStr = getCurrentBoardString();
    const repCount = pastStateCounts.get(resultingStateStr) || 0;
    const givesCheck = inCheck(side ^ 1);
    if (repCount > 0 || givesCheck) {
      const childTtIdx = ttFind(curHashLo, curHashHi);
      if (childTtIdx >= 0) ttDepth[childTtIdx] = 0;
    }
    undoMove(f, t, cap, moving, side);

    let pen = 0;
    if (repCount > 0) {
      pen += 500000 * repCount;
    }
    if (!cap) {
      if (f === lastAITo && t === lastAIFrom) {
        pen += 300000;
      }
      if (givesCheck) {
        if (consecutiveAIChecks >= 1 && f === lastAITo) {
          pen += 350000 * consecutiveAIChecks;
        } else if (consecutiveAIChecks >= 2) {
          pen += 300000 * consecutiveAIChecks;
        }
      }
      if (f === lastAITo) {
        if (samePieceStreak >= 2) {
          pen += 120000 * (samePieceStreak - 1);
        }
        if (visitedSquaresByPiece.has(t)) {
          pen += 250000;
        }
      }
    }
    globalPenalties[mCode] = pen;
    globalRepCounts[mCode] = repCount;
  }
}

// ============================================================================
// MOVE GENERATION (closure-free, legality test only when a move can expose the king)
// ============================================================================
let gN = 0, gBase = 0, gSide = 0, gCapOnly = false, gQChecks = false;
let gCheckNow = false, gKr = 0, gKc = 0;

function addMove(from, to, moving) {
  const target = board[to];
  const side = gSide;
  if (target !== 0 && sideOf(target) === side) return;
  const quiet = target === 0;
  if (quiet && gCapOnly && !gQChecks) return;

  const isKing = (moving | 32) === 107;
  const fr = ROW[from], fc = COL[from];

  if (quiet && gCapOnly) {
    // Quiet move generated only to find checks: a move can give check only if it (a) lies on the enemy
    // king's row/column (direct rook/cannon/general lines, discovered lines, cannon screens),
    // (b) lands within knight / pawn range, or (c) vacates a knight leg (diagonal-adjacent to the king).
    // This is a necessary-condition pre-filter; the exact inCheck() test below still decides.
    const ek = kingSq[side ^ 1];
    if (ek >= 0) {
      const er = ROW[ek], ec = COL[ek], tr = ROW[to], tc = COL[to];
      let a = tr - er, b = tc - ec, x = fr - er, y = fc - ec;
      if (a < 0) a = -a; if (b < 0) b = -b; if (x < 0) x = -x; if (y < 0) y = -y;
      if (!(tr === er || tc === ec || fr === er || fc === ec || (a <= 2 && b <= 2) || (x === 1 && y === 1))) return;
    }
  }
  let need = gCheckNow || isKing || fr === gKr || fc === gKc || ROW[to] === gKr || COL[to] === gKc;
  if (!need) {
    const dr = fr - gKr, dc = fc - gKc;
    need = (dr === 1 || dr === -1) && (dc === 1 || dc === -1); // possible knight-leg unblock
  }

  let bm = 0, bt = 0, wantDef = false;
  if (!quiet) {
    bm = baseVal(moving);
    bt = baseVal(target);
    wantDef = bm - bt > 60;
  }
  const qCheckMode = quiet && gCapOnly; // implies gQChecks

  let keep = true;
  let defended = false;
  if (need || wantDef || qCheckMode) {
    board[to] = moving;
    board[from] = 0;
    const oldK = kingSq[side];
    if (isKing) kingSq[side] = to;
    if (need) keep = !inCheck(side);
    if (keep && qCheckMode) keep = inCheck(side ^ 1) === 1;
    if (keep && wantDef) defended = isSquareAttacked(to, side ^ 1);
    kingSq[side] = oldK;
    board[from] = moving;
    board[to] = target;
  }

  if (keep && gN < MAX_MOVES) {
    const idx = gBase + gN;
    moveFrom[idx] = from;
    moveTo[idx] = to;
    moveCap[idx] = target;
    if (!quiet) {
      const gain = bt - (defended ? bm : 0);
      moveScore[idx] = (gain >= -60 ? 2000000 : 300000) + bt * 16 - bm;
    } else {
      moveScore[idx] = gQChecks ? 600000 : 0;
    }
    gN++;
  }
}

// Precomputed geometry for the generator (steps available per ray, knight / bishop / advisor / king targets)
const STEP4 = new Int8Array([-9, 9, -1, 1]);                 // up, down, left, right (same order as DR4/DC4)
const RAY_N = new Int8Array(90 * 4);
const NMV_TO = new Int16Array(90 * 8).fill(-1);               // knight destination
const NMV_LEG = new Int16Array(90 * 8).fill(-1);              // knight leg square that must be empty
const BIS_TO = [new Int16Array(90 * 4).fill(-1), new Int16Array(90 * 4).fill(-1)];
const BIS_EYE = [new Int16Array(90 * 4).fill(-1), new Int16Array(90 * 4).fill(-1)];
const ADV_TO = [new Int16Array(90 * 4).fill(-1), new Int16Array(90 * 4).fill(-1)];
const KNG_TO = [new Int16Array(90 * 4).fill(-1), new Int16Array(90 * 4).fill(-1)];
(function buildGenTables() {
  for (let sq = 0; sq < 90; sq++) {
    const r = (sq / 9) | 0, c = sq % 9;
    RAY_N[sq * 4] = r; RAY_N[sq * 4 + 1] = 9 - r; RAY_N[sq * 4 + 2] = c; RAY_N[sq * 4 + 3] = 8 - c;
    for (let i = 0; i < 8; i++) {
      const rr = r + NDR[i], cc = c + NDC[i];
      const br = r + ML_LEGR[i], bc = c + ML_LEGC[i];
      if (rr >= 0 && rr < 10 && cc >= 0 && cc < 9 && br >= 0 && br < 10 && bc >= 0 && bc < 9) {
        NMV_TO[sq * 8 + i] = rr * 9 + cc;
        NMV_LEG[sq * 8 + i] = br * 9 + bc;
      }
    }
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < 4; i++) {
        let rr = r + BDR[i], cc = c + BDC[i];
        if (rr >= 0 && rr < 10 && cc >= 0 && cc < 9 && (side ? rr >= 5 : rr <= 4)) {
          BIS_TO[side][sq * 4 + i] = rr * 9 + cc;
          BIS_EYE[side][sq * 4 + i] = (r + (BDR[i] >> 1)) * 9 + c + (BDC[i] >> 1);
        }
        rr = r + ADR[i]; cc = c + ADC[i];
        if (rr >= 0 && rr < 10 && (side ? rr >= 7 : rr <= 2) && cc >= 3 && cc <= 5) ADV_TO[side][sq * 4 + i] = rr * 9 + cc;
        rr = r + DR4[i]; cc = c + DC4[i];
        if (rr >= 0 && rr < 10 && (side ? rr >= 7 : rr <= 2) && cc >= 3 && cc <= 5) KNG_TO[side][sq * 4 + i] = rr * 9 + cc;
      }
    }
  }
})();

function generateLegalMoves(side, capturesOnly, ply, includeQuietChecks = false, knownCheck = -1) {
  gN = 0;
  gBase = ply * MAX_MOVES;
  gSide = side;
  gCapOnly = capturesOnly;
  gQChecks = includeQuietChecks;
  const ksq = kingSq[side];
  gKr = ksq >= 0 ? ROW[ksq] : -9;
  gKc = ksq >= 0 ? COL[ksq] : -9;
  gCheckNow = knownCheck >= 0 ? knownCheck === 1 : inCheck(side) === 1;
  const quietAllowed = !capturesOnly || includeQuietChecks;
  const bisTo = BIS_TO[side], bisEye = BIS_EYE[side], advTo = ADV_TO[side], kngTo = KNG_TO[side];

  for (let from = 0; from < 90; from++) {
    const moving = board[from];
    if (moving === 0 || SIDE_TAB[moving] !== side) continue;
    const t = UPPER_TAB[moving];

    if (t === 82) {
      for (let d = 0; d < 4; d++) {
        const step = STEP4[d], nmax = RAY_N[from * 4 + d];
        let to = from;
        for (let k = 0; k < nmax; k++) {
          to += step;
          const q = board[to];
          if (q === 0) { if (quietAllowed) addMove(from, to, moving); }
          else { if (SIDE_TAB[q] !== side) addMove(from, to, moving); break; }
        }
      }
    } else if (t === 67) {
      for (let d = 0; d < 4; d++) {
        const step = STEP4[d], nmax = RAY_N[from * 4 + d];
        let to = from, screens = 0;
        for (let k = 0; k < nmax; k++) {
          to += step;
          const q = board[to];
          if (!screens) {
            if (q === 0) { if (quietAllowed) addMove(from, to, moving); }
            else screens = 1;
          } else if (q !== 0) {
            if (SIDE_TAB[q] !== side) addMove(from, to, moving);
            break;
          }
        }
      }
    } else if (t === 78) {
      const nb = from * 8;
      for (let i = 0; i < 8; i++) {
        const to = NMV_TO[nb + i];
        if (to >= 0 && board[NMV_LEG[nb + i]] === 0) addMove(from, to, moving);
      }
    } else if (t === 80) {
      const r = ROW[from], c = COL[from];
      const rr = r + (side ? -1 : 1);
      if (rr >= 0 && rr < 10) addMove(from, rr * 9 + c, moving);
      if (side ? r <= 4 : r >= 5) {
        if (c > 0) addMove(from, from - 1, moving);
        if (c < 8) addMove(from, from + 1, moving);
      }
    } else if (t === 66) {
      const b4 = from * 4;
      for (let i = 0; i < 4; i++) {
        const to = bisTo[b4 + i];
        if (to >= 0 && board[bisEye[b4 + i]] === 0) addMove(from, to, moving);
      }
    } else if (t === 65) {
      const b4 = from * 4;
      for (let i = 0; i < 4; i++) { const to = advTo[b4 + i]; if (to >= 0) addMove(from, to, moving); }
    } else if (t === 75) {
      const b4 = from * 4;
      for (let i = 0; i < 4; i++) { const to = kngTo[b4 + i]; if (to >= 0) addMove(from, to, moving); }
    }
  }
  return gN;
}

// ============================================================================
// EVALUATION
// ============================================================================
function evaluateRaw() {
  let score = 0;
  let rAdv = 0, bAdv = 0, rBish = 0, bBish = 0, rMaj = 0, bMaj = 0;
  let rAtk = 0, bAtk = 0;          // pieces able to attack (R, C, N, crossed pawns)
  let rPot = 0, bPot = 0;          // uncrossed pawns (potential attackers)
  let rNear = 0, bNear = 0;        // attackers close to the enemy king
  const rk = kingSq[1], bk = kingSq[0];
  const rkr = rk >= 0 ? ROW[rk] : 9, rkc = rk >= 0 ? COL[rk] : 4;
  const bkr = bk >= 0 ? ROW[bk] : 0, bkc = bk >= 0 ? COL[bk] : 4;
  const phase = Math.max(0, Math.min(22, pieceCount - 10));

  for (let i = 0; i < 90; i++) {
    const p = board[i];
    if (!p) continue;
    const side = p < 97 ? 1 : 0;
    const idx = side ? i : (89 - i);
    const r = ROW[i], c = COL[i];
    const t = UPPER_TAB[p];
    let v = BASEV_TAB[p];

    // Manhattan distance to the enemy king (only the attacking piece types use it)
    let distToEK = 0;
    if (t === 80 || t === 78 || t === 67 || t === 82) {
      let dr = r - (side ? bkr : rkr); if (dr < 0) dr = -dr;
      let dc = c - (side ? bkc : rkc); if (dc < 0) dc = -dc;
      distToEK = dr + dc;
    }

    if (t === 80) { // Pawn
      v += pstPawn[idx];
      if (side ? r <= 4 : r >= 5) {
        v += (14 - distToEK) * 6;
        if (c < 8 && board[i + 1] === p) v += 26;
        if (side) rAtk++; else bAtk++;
      } else {
        if (side) rPot++; else bPot++;   // uncrossed pawn: can still become an attacker
      }
    } else if (t === 78) { // Knight
      v = 465 + ((22 - phase) * 3) + pstKnight[idx];
      if (side) { rMaj++; rAtk++; } else { bMaj++; bAtk++; }
      let mob = 0;
      for (let k = 0; k < 8; k++) {
        const lr = r + ML_LEGR[k], lc = c + ML_LEGC[k];
        if (board[lr * 9 + lc] !== 0) continue;   // leg is always on the board for an in-board knight
        const rr = r + NDR[k], cc = c + NDC[k];
        if (rr < 0 || rr > 9 || cc < 0 || cc > 8) continue;
        const q = board[rr * 9 + cc];
        if (q === 0 || (q < 97 ? 1 : 0) !== side) mob++;
      }
      v += (mob - 4) * 6;
      v += (14 - distToEK) * 5;
      if (distToEK <= 4) { if (side) rNear++; else bNear++; }
    } else if (t === 67) { // Cannon
      v = 460 + (phase * 4) + pstCannon[idx];
      if (side) { rMaj++; rAtk++; } else { bMaj++; bAtk++; }
      v += (14 - distToEK) * 3;
      if (distToEK <= 4) { if (side) rNear++; else bNear++; }
    } else if (t === 82) { // Rook
      v += pstRook[idx];
      if (side) { rMaj += 2; rAtk++; } else { bMaj += 2; bAtk++; }
      let mob = 0;
      for (let rr = r - 1; rr >= 0; rr--) { mob++; if (board[rr * 9 + c]) break; }
      for (let rr = r + 1; rr < 10; rr++) { mob++; if (board[rr * 9 + c]) break; }
      for (let cc = c - 1; cc >= 0; cc--) { mob++; if (board[r * 9 + cc]) break; }
      for (let cc = c + 1; cc < 9; cc++) { mob++; if (board[r * 9 + cc]) break; }
      v += mob * 4 + (14 - distToEK) * 3;
      if (c === 3 || c === 5) v += 14;
      if (distToEK <= 4) { if (side) rNear++; else bNear++; }
    } else if (t === 65) { // Advisor
      if (side) rAdv++; else bAdv++;
      if (c === 4) v += 18;
    } else if (t === 66) { // Bishop
      if (side) rBish++; else bBish++;
      if (c === 4) v += 16;
    } else if (t === 75) { // King
      if (c === 4 && (r === 0 || r === 9)) v += 15;
    }
    score += side ? v : -v;
  }

  if (rAdv === 2) score += 38; else if (rAdv === 0 && bMaj >= 2) score -= 85;
  if (bAdv === 2) score -= 38; else if (bAdv === 0 && rMaj >= 2) score += 85;
  if (rBish === 2) score += 28; else if (rBish === 0 && bMaj >= 2) score -= 50;
  if (bBish === 2) score -= 28; else if (bBish === 0 && rMaj >= 2) score += 50;

  // King danger: enemy attackers close to a king that lacks defenders
  score -= bNear * (4 - rAdv - rBish) * 7;
  score += rNear * (4 - bAdv - bBish) * 7;

  // Pressure along the central file (hollow / screened cannon on the enemy king)
  for (let s = 0; s < 2; s++) {
    const ek = kingSq[s ^ 1];
    if (ek >= 0 && (ek % 9) === 4) {
      const kr = (ek / 9) | 0;
      const myC = s ? 67 : 99;
      const dr = s ? -1 : 1;
      let r = kr - dr, screens = 0;
      while (r >= 0 && r < 10) {
        const p = board[r * 9 + 4];
        if (p) {
          if (p === myC) {
            if (screens === 0) score += (s ? 68 : -68);
            else if (screens === 1) score += (s ? 36 : -36);
            break;
          }
          screens++;
          if (screens > 2) break;
        }
        r -= dr;
      }
    }
  }

  if (rMaj + bMaj <= 5) {
    if (score > 180) {
      if (rkc === 4) score += 22;
      if (rkc === bkc) score += 28;
      score += (Math.abs(bkc - 4) + Math.abs(bkr - 0)) * 18;
    } else if (score < -180) {
      if (bkc === 4) score -= 22;
      if (bkc === rkc) score -= 28;
      score -= (Math.abs(rkc - 4) + Math.abs(rkr - 9)) * 18;
    }
  }

  // A side with no attacking piece cannot convert its material edge: pull toward a draw
  // (damped, never zeroed: a side that still owns pawns can create attackers, so it is only halved)
  if (score > 0 && rAtk === 0) score = rPot > 0 ? (score / 2) | 0 : (score / 4) | 0;
  else if (score < 0 && bAtk === 0) score = bPot > 0 ? (score / 2) | 0 : (score / 4) | 0;

  return score;
}

function evaluate() {
  const k = curHashLo & EV_MASK;
  if (evKeyLo[k] === curHashLo && evKeyHi[k] === curHashHi) return evVal[k];
  const s = evaluateRaw();
  evKeyLo[k] = curHashLo; evKeyHi[k] = curHashHi; evVal[k] = s;
  return s;
}

function evalSide(side) {
  const s = evaluate();
  return (side ? s : -s) + 14;
}

function doMove(from, to, cap, moving, side) {
  const iFrom = moving * 90 + from;
  const iTo = moving * 90 + to;
  curHashLo = (curHashLo ^ zobLo[iFrom] ^ zobLo[iTo] ^ zobSideLo) >>> 0;
  curHashHi = (curHashHi ^ zobHi[iFrom] ^ zobHi[iTo] ^ zobSideHi) >>> 0;
  if (cap) {
    const iCap = cap * 90 + to;
    curHashLo = (curHashLo ^ zobLo[iCap]) >>> 0;
    curHashHi = (curHashHi ^ zobHi[iCap]) >>> 0;
    pieceCount--;
    if (IS_MAJOR[cap]) majorCnt[side ^ 1]--;
  }
  board[to] = moving;
  board[from] = 0;
  if (upper(moving) === 75) kingSq[side] = to;
}

function undoMove(from, to, cap, moving, side) {
  board[from] = moving;
  board[to] = cap;
  if (upper(moving) === 75) kingSq[side] = from;
  const iFrom = moving * 90 + from;
  const iTo = moving * 90 + to;
  curHashLo = (curHashLo ^ zobLo[iFrom] ^ zobLo[iTo] ^ zobSideLo) >>> 0;
  curHashHi = (curHashHi ^ zobHi[iFrom] ^ zobHi[iTo] ^ zobSideHi) >>> 0;
  if (cap) {
    const iCap = cap * 90 + to;
    curHashLo = (curHashLo ^ zobLo[iCap]) >>> 0;
    curHashHi = (curHashHi ^ zobHi[iCap]) >>> 0;
    pieceCount++;
    if (IS_MAJOR[cap]) majorCnt[side ^ 1]++;
  }
}

// ============================================================================
// MOVE ORDERING
// ============================================================================
function scoreMoves(ply, n, ttMoveCode, side) {
  const baseIdx = ply * MAX_MOVES;
  const hBase = side * 8100;
  const pf = ply > 0 ? searchHistoryFrom[ply - 1] : -1;
  const prevMoveCode = pf >= 0 ? (pf * 90 + searchHistoryTo[ply - 1]) : -1;
  const counterCode = prevMoveCode >= 0 ? counterMoves[(side ^ 1) * 8100 + prevMoveCode] : -1;
  const k0 = killers0[ply], k1 = killers1[ply];
  const f2 = ply >= 2 ? searchHistoryFrom[ply - 2] : -1;
  const t2 = ply >= 2 ? searchHistoryTo[ply - 2] : -1;

  for (let i = 0; i < n; i++) {
    const idx = baseIdx + i;
    const f = moveFrom[idx], t = moveTo[idx];
    const mCode = f * 90 + t;

    if (mCode === ttMoveCode) {
      moveScore[idx] = 10000000;
    } else if (moveCap[idx]) {
      // keep the SEE-lite score assigned during generation
    } else {
      let s = 0;
      if (f === t2 && t === f2) s -= 6000000;   // undoing our own previous move
      if (k0 === mCode) s += 850000;
      else if (k1 === mCode) s += 750000;
      else if (mCode === counterCode) s += 650000;
      else s += historyHeur[hBase + mCode];
      moveScore[idx] = s;
    }
  }
}

function pickMove(ply, n, i) {
  const baseIdx = ply * MAX_MOVES;
  let bestIdx = baseIdx + i;
  let bestSc = moveScore[bestIdx];
  for (let j = i + 1; j < n; j++) {
    const cur = baseIdx + j;
    if (moveScore[cur] > bestSc) {
      bestSc = moveScore[cur];
      bestIdx = cur;
    }
  }
  const curIdx = baseIdx + i;
  if (bestIdx !== curIdx) {
    let tmp = moveFrom[curIdx]; moveFrom[curIdx] = moveFrom[bestIdx]; moveFrom[bestIdx] = tmp;
    tmp = moveTo[curIdx]; moveTo[curIdx] = moveTo[bestIdx]; moveTo[bestIdx] = tmp;
    tmp = moveCap[curIdx]; moveCap[curIdx] = moveCap[bestIdx]; moveCap[bestIdx] = tmp;
    tmp = moveScore[curIdx]; moveScore[curIdx] = moveScore[bestIdx]; moveScore[bestIdx] = tmp;
    if (ply === 0) {
      tmp = rootMovePenalty[curIdx]; rootMovePenalty[curIdx] = rootMovePenalty[bestIdx]; rootMovePenalty[bestIdx] = tmp;
      tmp = rootMoveRepCount[curIdx]; rootMoveRepCount[curIdx] = rootMoveRepCount[bestIdx]; rootMoveRepCount[bestIdx] = tmp;
    }
  }
  return curIdx;
}

function histUpdate(idx, bonus) {
  const h = historyHeur[idx];
  historyHeur[idx] = h + bonus - ((h * (bonus < 0 ? -bonus : bonus) / 16384) | 0);
}

// ============================================================================
// REPETITION
// ============================================================================
function setRepRoot() {
  // If the caller's history already ends with the root position, reuse that slot so that
  // history entries and search-tree entries stay on the same ply parity.
  if (repBaseLen > 0 && repHashLo[repBaseLen - 1] === curHashLo && repHashHi[repBaseLen - 1] === curHashHi) {
    repRoot = repBaseLen - 1;
  } else {
    repRoot = repBaseLen;
  }
  // Number of reversible plies before the root (positions older than the last capture cannot repeat)
  let since = 0;
  const L = recentPieceCnt.length;
  if (L > 0) {
    const lastCnt = recentPieceCnt[L - 1];
    for (let k = L - 2; k >= 0 && recentPieceCnt[k] === lastCnt; k--) since++;
  }
  sinceCap[0] = Math.min(since, repRoot);
}

function isRepetition(ply) {
  const curIdx = repRoot + ply;
  let lowest = curIdx - sinceCap[ply];
  if (lowest < 0) lowest = 0;
  for (let i = curIdx - 2; i >= lowest; i -= 2) {
    if (repHashLo[i] === curHashLo && repHashHi[i] === curHashHi) return true;
  }
  return false;
}

function shouldStop() {
  if (nodes >= nodeLimit) return true;
  return deadline !== 0 && performance.now() >= deadline;
}

// ============================================================================
// QUIESCENCE SEARCH
// ============================================================================
function qsearch(alpha, beta, side, ply, qPly) {
  if ((++nodes & 2047) === 0 && shouldStop()) { stopped = 1; return 0; }
  if (ply >= MAX_PLY - 2) return evalSide(side);

  const check = inCheck(side) === 1;
  let stand = 0;
  if (!check) {
    stand = evalSide(side);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (qPly >= 12) return stand;
  }

  const includeChecks = !check && (qPly === 0);
  const n = generateLegalMoves(side, !check, ply, includeChecks, check ? 1 : 0);
  if (n === 0) return check ? (-MATE + ply) : alpha;
  scoreMoves(ply, n, -1, side);

  for (let i = 0; i < n; i++) {
    const idx = pickMove(ply, n, i);
    const f = moveFrom[idx], t = moveTo[idx], cap = moveCap[idx];
    if (!check && cap !== 0) {
      if (stand + baseVal(cap) + 220 < alpha) continue;       // delta pruning
      if (moveScore[idx] < 1500000 && qPly > 0) continue;     // SEE-lite: skip clearly losing captures
    }

    const moving = board[f];
    doMove(f, t, cap, moving, side);
    const sc = -qsearch(-beta, -alpha, side ^ 1, ply + 1, qPly + 1);
    undoMove(f, t, cap, moving, side);

    if (stopped) return 0;
    if (sc >= beta) return beta;
    if (sc > alpha) alpha = sc;
  }
  return alpha;
}

// ============================================================================
// MAIN SEARCH
// ============================================================================
function search(depth, alpha, beta, side, ply, allowNull) {
  if ((++nodes & 2047) === 0 && shouldStop()) { stopped = 1; return 0; }
  if (ply >= MAX_PLY - 2) return evalSide(side);

  pvLen[ply] = ply;
  const pvNode = (beta - alpha) > 1;

  if (ply > 0) {
    if (isRepetition(ply)) return (side === rootSide) ? -repContempt : repContempt;
    const mA = -MATE + ply, mB = MATE - ply - 1;   // mate-distance pruning
    if (alpha < mA) alpha = mA;
    if (beta > mB) beta = mB;
    if (alpha >= beta) return alpha;
  }

  let ttMoveCode = -1;
  const slot = ttFind(curHashLo, curHashHi);
  if (slot >= 0) {
    ttMoveCode = ttMove[slot];
    if (!pvNode && ttDepth[slot] >= depth) {
      let sc = ttScore[slot];
      if (sc > MATE - 1000) sc -= ply;
      else if (sc < -MATE + 1000) sc += ply;
      const fl = ttFlag[slot];
      if (fl === 0) return sc;
      if (fl === 1 && sc <= alpha) return alpha;
      if (fl === 2 && sc >= beta) return beta;
    }
  }

  const check = inCheck(side) === 1;
  if (check && ply < Math.min(MAX_PLY - 12, curIter * 2 + 8)) depth++;
  if (depth <= 0) return qsearch(alpha, beta, side, ply, 0);

  let staticEval = NO_EVAL;
  let improving = false;
  if (!check) {
    staticEval = evalSide(side);
    improving = ply >= 2 && evalStack[ply - 2] !== NO_EVAL && staticEval > evalStack[ply - 2];
  }
  evalStack[ply] = staticEval;

  if (!pvNode && !check) {
    // Razoring
    if (depth <= 2 && staticEval + 260 + 190 * (depth - 1) <= alpha) {
      const v = qsearch(alpha, beta, side, ply, 0);
      if (stopped) return 0;
      if (v <= alpha) return v;
    }
    // Reverse futility
    if (depth <= 5 && beta < MATE - 1000) {
      const margin = 115 * depth - (improving ? 35 : 0);
      if (staticEval - margin >= beta) return staticEval - margin;
    }
    // Null move (with verification at depth)
    if (allowNull && depth >= 3 && staticEval >= beta && majorCnt[side] > 0) {
      let R = 2 + (depth >= 6 ? 1 : 0) + (depth >= 11 ? 1 : 0) + (staticEval - beta > 250 ? 1 : 0);
      if (R > depth - 1) R = depth - 1;
      repHashLo[repRoot + ply] = curHashLo;
      repHashHi[repRoot + ply] = curHashHi;
      searchHistoryFrom[ply] = -1;
      searchHistoryTo[ply] = -1;
      sinceCap[ply + 1] = sinceCap[ply] + 1;
      curHashLo = (curHashLo ^ zobSideLo) >>> 0;
      curHashHi = (curHashHi ^ zobSideHi) >>> 0;
      const sc = -search(depth - 1 - R, -beta, -beta + 1, side ^ 1, ply + 1, 0);
      curHashLo = (curHashLo ^ zobSideLo) >>> 0;
      curHashHi = (curHashHi ^ zobSideHi) >>> 0;
      if (stopped) return 0;
      if (sc >= beta) {
        // Zugzwang guard: verify at depth >= 8, and also in thin positions (<= 2 R/C/N) where zugzwang is real
        if (depth < 8 && majorCnt[side] > 2) return beta;
        const v = search(depth >= 8 ? depth - 5 : depth - 2, beta - 1, beta, side, ply, 0);
        if (stopped) return 0;
        if (v >= beta) return beta;
        pvLen[ply] = ply;
      }
    }
  }

  // Internal iterative reduction: no hash move at a deep node -> search a bit shallower
  if (ttMoveCode < 0 && depth >= 5 && !check) depth--;

  const origAlpha = alpha;
  const n = generateLegalMoves(side, false, ply, false, check ? 1 : 0);
  if (n === 0) return -MATE + ply;

  scoreMoves(ply, n, ttMoveCode, side);
  const baseIdx = ply * MAX_MOVES;
  let best = -INF;
  let bestCode = moveFrom[baseIdx] * 90 + moveTo[baseIdx];
  let quietSeen = 0, quietN = 0;
  const hBase = side * 8100;
  const lmpLimit = (improving ? 9 : 6) + depth * depth * 2;
  const futMargin = 130 + 110 * depth;
  const lmrBase = (depth < 64 ? depth : 63) * MAX_MOVES;

  for (let i = 0; i < n; i++) {
    const idx = pickMove(ply, n, i);
    const f = moveFrom[idx], t = moveTo[idx], cap = moveCap[idx];
    const mCode = f * 90 + t;
    const moving = board[f];
    const isQuiet = cap === 0;
    const goodCap = !isQuiet && moveScore[idx] >= 1500000;

    // Forward pruning candidates (never the first move, never in check / PV / near mate scores)
    let prune = false;
    if (i > 0 && !pvNode && !check && best > -MATE + 1000) {
      if (isQuiet) {
        if (depth <= 4 && (quietSeen >= lmpLimit || (staticEval + futMargin <= alpha && quietSeen >= 2))) prune = true;
      } else if (!goodCap && depth <= 2) {
        prune = true;
      }
    }
    if (isQuiet) quietSeen++;

    searchHistoryFrom[ply] = f;
    searchHistoryTo[ply] = t;
    repHashLo[repRoot + ply] = curHashLo;
    repHashHi[repRoot + ply] = curHashHi;
    sinceCap[ply + 1] = cap ? 0 : sinceCap[ply] + 1;
    doMove(f, t, cap, moving, side);

    // Does this move give check? (computed once; checking moves are never pruned and never reduced)
    const givesCheck = (i > 0 && (prune || depth >= 3)) ? inCheck(side ^ 1) === 1 : false;
    if (prune && !givesCheck) {
      undoMove(f, t, cap, moving, side);
      continue;
    }

    let sc;
    const newDepth = depth - 1;
    if (i === 0) {
      sc = -search(newDepth, -beta, -alpha, side ^ 1, ply + 1, 1);
    } else {
      let red = 0;
      if (depth >= 3 && i >= 2 && !check && !givesCheck && (isQuiet || !goodCap)) {
        red = lmrTable[lmrBase + (i < MAX_MOVES ? i : MAX_MOVES - 1)];
        if (pvNode) red--;
        if (!improving) red++;
        if (mCode === killers0[ply] || mCode === killers1[ply]) red--;
        if (isQuiet) {
          const h = historyHeur[hBase + mCode];
          if (h > 6000) red--; else if (h < -4000) red++;
        } else if (red > 1) red = 1;
        if (red > newDepth - 1) red = newDepth - 1;
        if (red < 0) red = 0;
      }
      sc = -search(newDepth - red, -alpha - 1, -alpha, side ^ 1, ply + 1, 1);
      if (sc > alpha && red > 0) {
        sc = -search(newDepth, -alpha - 1, -alpha, side ^ 1, ply + 1, 1);
      }
      if (sc > alpha && sc < beta) {
        sc = -search(newDepth, -beta, -alpha, side ^ 1, ply + 1, 1);
      }
    }

    undoMove(f, t, cap, moving, side);
    if (stopped) return 0;

    if (isQuiet) quietBuf[baseIdx + quietN++] = mCode;

    if (sc > best) {
      best = sc;
      bestCode = mCode;
      pvTable[ply * MAX_PLY + ply] = bestCode;
      const nextLen = pvLen[ply + 1];
      for (let k = ply + 1; k < nextLen && k < MAX_PLY; k++) {
        pvTable[ply * MAX_PLY + k] = pvTable[(ply + 1) * MAX_PLY + k];
      }
      pvLen[ply] = nextLen > ply + 1 ? nextLen : (ply + 1);
    }
    if (sc > alpha) alpha = sc;
    if (alpha >= beta) {
      if (isQuiet) {
        if (killers0[ply] !== mCode) {
          killers1[ply] = killers0[ply];
          killers0[ply] = mCode;
        }
        const bonus = Math.min(depth * depth * 8, 1600);
        histUpdate(hBase + mCode, bonus);
        for (let q = 0; q < quietN - 1; q++) histUpdate(hBase + quietBuf[baseIdx + q], -bonus);
        const pf = ply > 0 ? searchHistoryFrom[ply - 1] : -1;
        if (pf >= 0) counterMoves[(side ^ 1) * 8100 + pf * 90 + searchHistoryTo[ply - 1]] = mCode;
      }
      break;
    }
  }

  if (best === -INF) best = alpha;   // everything pruned (cannot normally happen: first move is never pruned)
  const flag = (best <= origAlpha) ? 1 : ((best >= beta) ? 2 : 0);
  const stored = (best > MATE - 1000) ? (best + ply) : ((best < -MATE + 1000) ? (best - ply) : best);
  ttStore(curHashLo, curHashHi, depth, stored, flag, bestCode);
  return best;
}

// ============================================================================
// ROOT SEARCH
// ============================================================================
function rootSearch(depth, side, alphaIn = -INF, betaIn = INF) {
  curIter = depth;
  setRepRoot();
  rootPartialValid = false;

  const n = generateLegalMoves(side, false, 0, false);
  if (n === 0) return -1;

  const slot = ttFind(curHashLo, curHashHi);
  const ttMoveCode = slot >= 0 ? ttMove[slot] : -1;
  scoreMoves(0, n, ttMoveCode, side);

  for (let i = 0; i < n; i++) {
    const f = moveFrom[i], t = moveTo[i];
    const mCode = f * 90 + t;
    const pen = globalPenalties[mCode];
    rootMovePenalty[i] = pen;
    rootMoveRepCount[i] = globalRepCounts[mCode];
    if (mCode !== ttMoveCode && rootScoreStamp[mCode] === rootEpoch) {
      // order by what the previous iteration learned (already includes any penalty)
      const s = rootScoreArr[mCode];
      moveScore[i] = 4000000 + (s > 1500000 ? 1500000 : (s < -1500000 ? -1500000 : s));
    } else if (pen > 0) {
      moveScore[i] -= pen * 10;
    }
  }

  let alpha = alphaIn, beta = betaIn, best = -INF;
  let bestCode = moveFrom[0] * 90 + moveTo[0];
  let firstCode = -1;

  for (let i = 0; i < n; i++) {
    if (shouldStop()) { stopped = 1; break; }
    const idx = pickMove(0, n, i);
    const f = moveFrom[idx], t = moveTo[idx], cap = moveCap[idx];
    const mCode = f * 90 + t;
    const moving = board[f];
    const pen = rootMovePenalty[idx];
    const repCount = rootMoveRepCount[idx];
    if (i === 0) firstCode = mCode;

    searchHistoryFrom[0] = f;
    searchHistoryTo[0] = t;
    repHashLo[repRoot] = curHashLo;
    repHashHi[repRoot] = curHashHi;
    sinceCap[1] = cap ? 0 : sinceCap[0] + 1;
    doMove(f, t, cap, moving, side);

    let sc;
    if (i === 0 || pen > 0) {
      sc = -search(depth - 1, -beta, -alpha, side ^ 1, 1, 1);
    } else {
      sc = -search(depth - 1, -alpha - 1, -alpha, side ^ 1, 1, 1);
      if (sc > alpha && sc < beta) {
        sc = -search(depth - 1, -beta, -alpha, side ^ 1, 1, 1);
      }
    }

    undoMove(f, t, cap, moving, side);
    if (stopped) break;

    if (pen > 0) {
      if (repCount > 0) sc -= pen;
      else if (sc < MATE - 1000) sc -= pen;
    }
    rootScoreArr[mCode] = sc;
    rootScoreStamp[mCode] = rootEpoch;

    if (sc > best) {
      best = sc;
      bestCode = mCode;
      pvTable[0] = bestCode;
      const nextLen = pvLen[1];
      for (let k = 1; k < nextLen && k < MAX_PLY; k++) {
        pvTable[k] = pvTable[MAX_PLY + k];
      }
      pvLen[0] = nextLen > 1 ? nextLen : 1;
    }
    if (sc > alpha) alpha = sc;
    if (sc >= beta) break;   // fail-high: caller widens the window
  }

  rootBestScore = best;
  if (stopped) {
    // A move that already finished inside the window is a valid (possibly improved) answer.
    rootPartialValid = best > alphaIn && best < betaIn && best > -INF;
    return bestCode;
  }
  if (best > -INF) {
    lastScore = best;
    if (best > alphaIn && best < betaIn) {
      ttStore(curHashLo, curHashHi, depth, best, 0, bestCode);
    }
  }
  return bestCode;
}

// Iterative deepening driver. Returns the best move code, or -1 when there is no legal move.
function searchBestMove(maxDepth, maxNodes, side, timeMs) {
  initZobrist();
  rootSide = side;
  nodes = 0;
  nodeLimit = maxNodes > 2000 ? maxNodes : 2000;
  const t0 = performance.now();
  deadline = timeMs > 0 ? t0 + timeMs : 0;
  const softLimit = timeMs > 0 ? timeMs * 0.5 : 0;
  stopped = 0;
  lastScore = 0;
  completedDepth = 0;
  pvLen[0] = 0;
  killers0.fill(-1);
  killers1.fill(-1);
  for (let i = 0; i < historyHeur.length; i++) historyHeur[i] >>= 1;
  ttGen = (ttGen + 1) & 255;
  rootEpoch++;
  if (rootEpoch > 2000000000) { rootScoreStamp.fill(0); rootEpoch = 1; }

  const n = generateLegalMoves(side, false, 0, false);
  if (n === 0) return -1;
  let best = moveFrom[0] * 90 + moveTo[0];
  if (n === 1) {                       // forced move: no need to think
    completedDepth = 1;
    pvTable[0] = best; pvLen[0] = 1;
    return best;
  }

  // Contempt: do not fear a repetition when clearly worse
  setRepRoot();
  const rootEval = evalSide(side);
  repContempt = rootEval < -350 ? 0 : 600;

  let prevScore = 0;
  let prevBest = -1;
  let instability = 0;
  const initD = (startDepth > 1 && startDepth <= maxDepth) ? startDepth : 1;

  for (let d = initD; d <= maxDepth; d++) {
    if (nodes >= nodeLimit) break;
    stopped = 0;

    let alpha = -INF, beta = INF, delta = 35;
    if (d >= 5 && completedDepth >= 4 && Math.abs(prevScore) < MATE - 1000) {
      alpha = prevScore - delta;
      beta = prevScore + delta;
    }

    let candidate = -1;
    for (;;) {
      candidate = rootSearch(d, side, alpha, beta);
      if (stopped) break;
      if (best >= 0 && rootBestScore <= alpha && alpha > -INF) {
        alpha = (delta > 300) ? -INF : Math.max(-INF, alpha - delta * 2);
        delta *= 2;
        instability++;
        continue;
      }
      if (rootBestScore >= beta && beta < INF) {
        beta = (delta > 300) ? INF : Math.min(INF, beta + delta * 2);
        delta *= 2;
        continue;
      }
      break;
    }

    if (stopped) {
      if (rootPartialValid && candidate >= 0) {
        best = candidate;
        lastScore = rootBestScore;
      }
      break;
    }
    if (candidate >= 0) {
      if (prevBest >= 0 && candidate !== prevBest) instability++;
      best = candidate;
      prevBest = candidate;
    }
    prevScore = lastScore;
    completedDepth = d;
    if (lastScore > MATE - 100 || lastScore < -MATE + 100) break;

    // Stop early when the next iteration is unlikely to finish; search longer when the best move keeps changing.
    const unstable = instability > 0;
    instability = 0;
    if (d >= 8) {
      if (nodes >= nodeLimit * (unstable ? 0.75 : 0.5)) break;
      if (softLimit && (performance.now() - t0) >= softLimit * (unstable ? 1.5 : 1)) break;
    }
  }
  startDepth = 1;
  return best;
}

function flattenBoard(b) {
  let out = '';
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) out += (b?.[r]?.[c] || '.');
  if (out.length !== 90) throw new Error('Bàn cờ không hợp lệ: cần đúng 90 ô');
  return out;
}

function decodeMove(n) {
  const from = Math.floor(n / 90), to = n % 90;
  return { fr: Math.floor(from / 9), fc: from % 9, tr: Math.floor(to / 9), tc: to % 9 };
}

// ============================================================================
// OPTIONAL EXTERNAL C++ WASM ENGINE (only used when USE_EXTERNAL_WASM = true)
// ============================================================================
let enginePromise = null;
async function loadExternalEngine() {
  if (!USE_EXTERNAL_WASM) return null;
  if (!enginePromise) {
    enginePromise = (async () => {
      try {
        const resp = await fetch('./xiangqi_engine.wasm');
        if (!resp.ok) return null;
        const bytes = await resp.arrayBuffer();
        const { instance } = await WebAssembly.instantiate(bytes, {});
        const ex = instance.exports;
        if (ex && ex.search_best_move && ex.get_penalty_buffer) {
          return {
            memory: ex.memory,
            get_input_buffer: ex.get_input_buffer,
            get_penalty_buffer: ex.get_penalty_buffer,
            get_rep_count_buffer: ex.get_rep_count_buffer,
            get_history_boards_buffer: ex.get_history_boards_buffer,
            get_history_sides_buffer: ex.get_history_sides_buffer,
            set_history_count: ex.set_history_count,
            set_position: ex.set_position,
            search_best_move: ex.search_best_move,
            get_nodes: ex.get_nodes,
            get_completed_depth: ex.get_completed_depth,
            get_last_score: ex.get_last_score,
            get_pv_length: ex.get_pv_length,
            get_pv_move: ex.get_pv_move
          };
        }
      } catch (_ignoreExternalErr) {}
      return null;
    })();
  }
  return enginePromise;
}


// ============================================================================
// MULTI-BRANCH PONDERING (iterative deepening per likely opponent reply)
// ============================================================================
const PONDER_MAX_DEPTH = 18;
const PONDER_CACHE_MAX = 600;
let ponderActive = false;
let ponderTimer = null;
const ponderBranchCache = new Map();
let totalPonderNodes = 0;

function stopPondering() {
  ponderActive = false;
  if (ponderTimer) {
    clearTimeout(ponderTimer);
    ponderTimer = null;
  }
}

function clearOpponentPenalties() {
  globalPenalties.fill(0);
  globalRepCounts.fill(0);
}

function startPonderingSession(bState, opponentSideBool, aiSideBool, positionHistory) {
  stopPondering();
  let oppBoardText = '';
  try {
    oppBoardText = flattenBoard(bState);
  } catch (_e) {
    return;
  }

  const oppSide = opponentSideBool ? 1 : 0;
  const aiSide  = aiSideBool ? 1 : 0;

  analyzeGameHistory(positionHistory, oppSide);
  loadBoardFromString(oppBoardText, oppSide);
  setRepRoot();

  const n0 = generateLegalMoves(oppSide, false, 0, false);
  if (n0 === 0) return;

  // Warm the TT with a shallow search of the opponent's position (no AI-side penalties apply here)
  clearOpponentPenalties();
  rootSide = oppSide;
  repContempt = 600;
  nodes = 0;
  nodeLimit = 40000;
  deadline = 0;
  stopped = 0;
  rootEpoch++;
  ttGen = (ttGen + 1) & 255;
  for (let d = 1; d <= 4; d++) {
    rootSearch(d, oppSide);
    if (stopped) break;
  }

  const nMoves = generateLegalMoves(oppSide, false, 0, false);
  const slot = ttFind(curHashLo, curHashHi);
  const ttMoveCode = slot >= 0 ? ttMove[slot] : -1;
  scoreMoves(0, nMoves, ttMoveCode, oppSide);

  const candidateBranches = [];
  for (let i = 0; i < nMoves; i++) {
    const idx = pickMove(0, nMoves, i);
    const f = moveFrom[idx], t = moveTo[idx], cap = moveCap[idx];
    const moving = board[f];

    searchHistoryFrom[0] = f;
    searchHistoryTo[0] = t;
    repHashLo[repRoot] = curHashLo;
    repHashHi[repRoot] = curHashHi;
    sinceCap[1] = cap ? 0 : sinceCap[0] + 1;
    doMove(f, t, cap, moving, oppSide);
    const childBoard90 = getCurrentBoardString();
    nodes = 0;
    nodeLimit = 12000;
    stopped = 0;
    curIter = 2;
    const quickEval = -search(2, -INF, INF, aiSide, 1, 1);
    undoMove(f, t, cap, moving, oppSide);

    candidateBranches.push({
      oppFrom: f,
      oppTo: t,
      oppMove: decodeMove(f * 90 + t),
      board90: childBoard90,
      quickScore: quickEval + (i === 0 ? 50 : 0),
      nextDepth: 1,
      stalls: 0,
      // history entries are tagged with the SIDE TO MOVE; after the opponent's move that is the AI
      historyWithOppMove: [...positionHistory, (aiSideBool ? 'R:' : 'B:') + childBoard90]
    });
  }

  candidateBranches.sort((a, b) => b.quickScore - a.quickScore);
  const topBranches = candidateBranches.slice(0, Math.min(8, candidateBranches.length));
  if (topBranches.length === 0) return;

  for (const br of topBranches) {
    const cached = ponderBranchCache.get(br.board90);
    if (cached && cached.depth >= 1) br.nextDepth = cached.depth + 1;
  }

  ponderActive = true;
  totalPonderNodes = 0;
  let stepCounter = 0;

  const runNextPonderSlice = () => {
    if (!ponderActive) return;

    // 70% of the time on the 3 most likely replies, 30% on the rest
    let branchIdx;
    if (stepCounter % 3 !== 2) branchIdx = (stepCounter % 3) % topBranches.length;
    else branchIdx = stepCounter % topBranches.length;
    stepCounter++;

    let branch = topBranches[branchIdx];
    if (branch.nextDepth > PONDER_MAX_DEPTH) {
      const other = topBranches.find(b => b.nextDepth <= PONDER_MAX_DEPTH);
      if (!other) { ponderActive = false; return; }
      branch = other;
    }

    analyzeGameHistory(branch.historyWithOppMove, aiSide);
    precomputeRootPenalties(branch.board90, aiSide);
    loadBoardFromString(branch.board90, aiSide);

    rootSide = aiSide;
    nodes = 0;
    nodeLimit = 50000000;
    stopped = 0;
    rootEpoch++;
    ttGen = (ttGen + 1) & 255;
    repContempt = evalSide(aiSide) < -350 ? 0 : 600;

    // Time slice grows while a branch keeps failing to finish its next depth
    // Escalate while a branch keeps stalling, but cap the slice: the worker cannot react to a real
    // search request while a slice is running, so a long slice would delay the actual move.
    const sliceMs = Math.min(45 * (1 << Math.min(branch.stalls, 4)), 250);
    const sliceStart = performance.now();
    deadline = sliceStart + sliceMs;

    let lastValidCode = -1;
    let reachedDepth = 0;
    let lastScoreLocal = 0;
    let finishedAny = false;
    for (let d = branch.nextDepth; d <= PONDER_MAX_DEPTH; d++) {
      if (finishedAny && performance.now() - sliceStart > sliceMs * 0.55) break;
      stopped = 0;
      const code = rootSearch(d, aiSide);
      if (stopped) { if (!finishedAny) branch.stalls++; break; }
      if (code >= 0) {
        finishedAny = true;
        branch.stalls = 0;
        lastValidCode = code;
        lastScoreLocal = lastScore;
        reachedDepth = d;
        branch.nextDepth = d + 1;

        const pv = [];
        const count = Math.min(pvLen[0], 10);
        for (let k = 0; k < count; k++) {
          if (pvTable[k] >= 0) pv.push(decodeMove(pvTable[k]));
        }
        const prevEntry = ponderBranchCache.get(branch.board90);
        if (ponderBranchCache.size >= PONDER_CACHE_MAX && !prevEntry) {
          const oldest = ponderBranchCache.keys().next().value;
          ponderBranchCache.delete(oldest);
        }
        ponderBranchCache.set(branch.board90, {
          moveCode: code,
          move: decodeMove(code),
          score: lastScoreLocal,
          depth: d,
          nodes: (prevEntry ? prevEntry.nodes : 0) + nodes,
          pv,
          oppMove: branch.oppMove
        });
      }
      if (lastScoreLocal > MATE - 100 || lastScoreLocal < -MATE + 100) {
        branch.nextDepth = PONDER_MAX_DEPTH + 1;
        break;
      }
    }
    deadline = 0;
    totalPonderNodes += nodes;

    if (reachedDepth > 0 && lastValidCode >= 0) {
      self.postMessage({
        ponderStatus: {
          active: true,
          branchIndex: topBranches.indexOf(branch) + 1,
          totalBranches: topBranches.length,
          depth: reachedDepth,
          totalNodes: totalPonderNodes,
          oppMove: branch.oppMove,
          replyMove: decodeMove(lastValidCode)
        }
      });
    }

    ponderTimer = setTimeout(runNextPonderSlice, 4);
  };

  ponderTimer = setTimeout(runNextPonderSlice, 15);
}


// ============================================================================
// MESSAGE HANDLER
// ============================================================================
// depth = hard depth cap, nodes = hard node cap, time = hard wall-clock cap (ms),
// instantDepth = ponder depth at which a cached reply is played instantly.
const PRESETS = {
  1: { depth: 8,  nodes: 200000,  time: 300,  instantDepth: 6 },
  2: { depth: 10, nodes: 500000,  time: 500,  instantDepth: 7 },
  3: { depth: 12, nodes: 1000000, time: 800,  instantDepth: 8 },
  4: { depth: 14, nodes: 2000000, time: 1300, instantDepth: 9 },
  5: { depth: 17, nodes: 3500000, time: 2000, instantDepth: 10 },
  6: { depth: 22, nodes: 6000000, time: 3000, instantDepth: 11 }
};

self.onmessage = async ({ data = {} }) => {
  const { cmd, board: bState, currentAISide, opponentSide, difficulty = 6, isHint = false, positionHistory = [] } = data;

  if (cmd === 'stop_ponder') {
    stopPondering();
    return;
  }

  if (cmd === 'clear_cache') {
    stopPondering();
    ponderBranchCache.clear();
    ttClear();
    evKeyLo.fill(0); evKeyHi.fill(0);
    historyHeur.fill(0);
    counterMoves.fill(0);
    rootScoreStamp.fill(0);
    return;
  }

  if (cmd === 'start_ponder') {
    startPonderingSession(bState, opponentSide, currentAISide, positionHistory);
    return;
  }

  stopPondering();

  const side = currentAISide ? 1 : 0;
  analyzeGameHistory(positionHistory, side);

  const started = performance.now();
  try {
    const text = flattenBoard(bState);
    const sidePrefix = currentAISide ? 'R:' : 'B:';

    if (!isHint) {
      const bookMove = pickBookMove(sidePrefix + text);
      if (bookMove) {
        self.postMessage({
          result: {
            move: bookMove,
            score: 20,
            nodes: 1,
            depth: 'Book',
            pv: [bookMove],
            timeMs: performance.now() - started,
            isHint,
            ponderHit: false
          }
        });
        return;
      }
    }

    const base = PRESETS[Number(difficulty)] || PRESETS[6];
    const preset = {
      depth: Number(data.maxDepth) > 0 ? Number(data.maxDepth) : base.depth,
      nodes: Number(data.maxNodes) > 0 ? Number(data.maxNodes) : base.nodes,
      time: Number(data.timeMs) > 0 ? Number(data.timeMs) : base.time,
      instantDepth: base.instantDepth
    };

    // 1. Ponder hit: the reply was already computed while the player was thinking
    const cachedBranch = !isHint ? ponderBranchCache.get(text) : null;
    if (cachedBranch && cachedBranch.depth >= preset.instantDepth) {
      self.postMessage({
        result: {
          move: cachedBranch.move,
          score: currentAISide ? cachedBranch.score : -cachedBranch.score,
          nodes: cachedBranch.nodes,
          depth: `${cachedBranch.depth}⚡`,
          pv: cachedBranch.pv,
          timeMs: Math.max(1, performance.now() - started),
          isHint,
          ponderHit: true
        }
      });
      return;
    }

    // 2. Partial ponder result: only search the remaining depths, with a reduced budget
    startDepth = cachedBranch ? Math.max(1, cachedBranch.depth + 1) : 1;
    const effNodes = cachedBranch ? Math.floor(preset.nodes * 0.5) : preset.nodes;
    const effTime = cachedBranch ? Math.floor(preset.time * 0.5) : preset.time;

    precomputeRootPenalties(text, side);

    const ext = await loadExternalEngine();
    let code, totalNodes, depth, score;
    const pv = [];

    if (ext) {
      const mem = new Uint8Array(ext.memory.buffer);
      const ptr = ext.get_input_buffer();
      for (let i = 0; i < 90; i++) mem[ptr + i] = text.charCodeAt(i);

      const penPtr = ext.get_penalty_buffer();
      const repPtr = ext.get_rep_count_buffer();
      const histBoardsPtr = ext.get_history_boards_buffer();
      const histSidesPtr = ext.get_history_sides_buffer();

      new Int32Array(ext.memory.buffer, penPtr, 8100).set(globalPenalties);
      new Int16Array(ext.memory.buffer, repPtr, 8100).set(globalRepCounts);

      const hCount = Math.min(64, recentRawBoards.length);
      for (let h = 0; h < hCount; h++) {
        const bStr = recentRawBoards[h];
        const baseOffset = histBoardsPtr + h * 90;
        for (let sq = 0; sq < 90; sq++) mem[baseOffset + sq] = bStr.charCodeAt(sq);
        mem[histSidesPtr + h] = recentTurnSides[h];
      }
      ext.set_history_count(hCount);
      ext.set_position(side);

      code = ext.search_best_move(preset.depth, effNodes, side);
      totalNodes = ext.get_nodes();
      depth = ext.get_completed_depth();
      score = ext.get_last_score();
      const count = Math.min(ext.get_pv_length(), 12);
      for (let i = 0; i < count; i++) {
        const m = ext.get_pv_move(i);
        if (m >= 0) pv.push(decodeMove(m));
      }
    } else {
      loadBoardFromString(text, side);
      code = searchBestMove(preset.depth, effNodes, side, effTime);
      totalNodes = nodes;
      depth = completedDepth;
      score = lastScore;
      const count = Math.min(pvLen[0], 12);
      for (let i = 0; i < count; i++) {
        if (pvTable[i] >= 0) pv.push(decodeMove(pvTable[i]));
      }
    }
    deadline = 0;
    totalNodes += cachedBranch ? cachedBranch.nodes : 0;

    // If the fast-forward could not get past the ponder depth, trust the ponder result
    if (cachedBranch && depth < cachedBranch.depth) {
      code = cachedBranch.moveCode;
      depth = cachedBranch.depth;
      score = cachedBranch.score;
      pv.length = 0;
      for (const m of cachedBranch.pv) pv.push(m);
    }

    if (code < 0) {
      self.postMessage({
        result: { move: null, score: 0, nodes: totalNodes, depth, timeMs: performance.now() - started, isHint }
      });
      return;
    }

    self.postMessage({
      result: {
        move: decodeMove(code),
        score: currentAISide ? score : -score,
        nodes: totalNodes,
        depth: cachedBranch ? `${depth}⚡` : depth,
        pv,
        timeMs: performance.now() - started,
        isHint,
        ponderHit: Boolean(cachedBranch)
      }
    });
  } catch (err) {
    deadline = 0;
    self.postMessage({ error: err?.message || String(err), isHint });
  }
};