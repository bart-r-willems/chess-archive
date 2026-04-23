// ═══════════════════════════════════════════════════════
//  Chess Archive Viewer — chess.js
//  All game logic, PGN parsing, board rendering and UI.
// ═══════════════════════════════════════════════════════

const BUILD = 'build: 13';

// ═══════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════
const DEFAULTS = {
  pieces:  'merida',
  squares: 'green',
  pgnFiles: [
    { label: 'My Games', file: '../pgn/my_games.pgn' }
  ],
  // Asset paths relative to viewer.html
  piecesRoot:    './pieces/',
  squaresRoot:   './squares/',
  popupDuration:  1500,  // ms — game-end result popup display time
  analyseDepth:   18,    // Stockfish search depth
};

let SETTINGS = { ...DEFAULTS };

async function loadSettings() {
  try {
    const r = await fetch('./settings.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    SETTINGS = { ...DEFAULTS, ...data };
    console.log('[settings] loaded:', SETTINGS);
  } catch(e) {
    console.warn('[settings] could not load settings.json, using defaults:', e.message);
  }
}

// ═══════════════════════════════════════════════════════
//  PIECE IMAGES
// ═══════════════════════════════════════════════════════
const PIECE_FILE = {
  wK:'wk', wQ:'wq', wR:'wr', wB:'wb', wN:'wn', wP:'wp',
  bK:'bk', bQ:'bq', bR:'br', bB:'bb', bN:'bn', bP:'bp',
};

function pieceUrl(code) {
  const stem = PIECE_FILE[code];
  const root = SETTINGS.piecesRoot || './pieces/';
  return stem ? `${root}${SETTINGS.pieces}/${stem}.svg` : null;
}

function squareUrl(isLight) {
  const root = SETTINGS.squaresRoot || './squares/';
  return `${root}${SETTINGS.squares}/${isLight ? 'white' : 'black'}.png`;
}

// ═══════════════════════════════════════════════════════
//  PGN PARSER
// ═══════════════════════════════════════════════════════
function parsePGN(text) {
  // Normalize line endings and strip BOM
  text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const games = [];
  const lines = text.split('\n');

  let tagLines  = [];
  let moveLines = [];
  let inTags    = false;

  function flushGame() {
    if (tagLines.length === 0) return;
    const tags = {};
    for (const line of tagLines) {
      const m = line.match(/^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]/);
      if (m) tags[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (Object.keys(tags).length === 0) { tagLines=[]; moveLines=[]; return; }
    const movesText = moveLines.join(' ');
    games.push({ tags, movesText, moves: parseMoves(movesText) });
    tagLines  = [];
    moveLines = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      if (!inTags && moveLines.length > 0) flushGame();
      inTags = true;
      tagLines.push(trimmed);
    } else if (inTags && trimmed === '') {
      inTags = false;
    } else if (!inTags) {
      moveLines.push(trimmed);
    }
  }
  flushGame();

  return games;
}

function parseMoves(text) {
  // Strip comments { ... } and ( ... ) variations, then tokenize
  let t = text;
  // Remove braced comments (possibly nested - do multiple passes)
  for (let i = 0; i < 5; i++) t = t.replace(/\{[^{}]*\}/g, ' ');
  // Remove parenthesized variations (simple single-level)
  for (let i = 0; i < 5; i++) t = t.replace(/\([^()]*\)/g, ' ');
  // Remove move numbers like 1. or 1... or 12...
  t = t.replace(/\d+\.+/g, ' ');
  // Remove result
  t = t.replace(/1-0|0-1|1\/2-1\/2|\*/g, ' ');
  // Remove NAG annotations $1 $2 etc
  t = t.replace(/\$\d+/g, ' ');
  // Tokenize
  const tokens = t.trim().split(/\s+/).filter(s => s.length > 0 && s !== '--');
  return tokens;
}

// ═══════════════════════════════════════════════════════
//  CHESS ENGINE (position + legal move generation)
// ═══════════════════════════════════════════════════════

const FILES = 'abcdefgh';
const RANKS = '12345678';

function sq(f, r) { return f + r; } // e.g. sq(0,0) = 'a1'
function sqToIdx(s) { return FILES.indexOf(s[0]) + (parseInt(s[1])-1)*8; }
function idxToSq(i) { return FILES[i%8] + (Math.floor(i/8)+1); }
function f(s) { return FILES.indexOf(s[0]); }
function r(s) { return parseInt(s[1])-1; }

class Chess {
  constructor() { this.reset(); }

  reset() {
    // board: array of 64, index = file + rank*8
    this.board = new Array(64).fill(null);
    this.turn = 'w';
    this.castling = { wK:true, wQ:true, bK:true, bQ:true };
    this.ep = null; // en passant target square
    this.halfmove = 0;
    this.fullmove = 1;
    this._setup();
  }

  _setup() {
    const backrank = ['R','N','B','Q','K','B','N','R'];
    for (let i=0;i<8;i++) {
      this.board[i]    = 'w'+backrank[i];
      this.board[i+8]  = 'wP';
      this.board[i+48] = 'bP';
      this.board[i+56] = 'b'+backrank[i];
    }
  }

  get(sq) { return this.board[sqToIdx(sq)]; }
  set(sq, p) { this.board[sqToIdx(sq)] = p; }

  clone() {
    const c = new Chess();
    c.board = [...this.board];
    c.turn = this.turn;
    c.castling = {...this.castling};
    c.ep = this.ep;
    c.halfmove = this.halfmove;
    c.fullmove = this.fullmove;
    return c;
  }

  // Apply a SAN move, return true if success
  applySAN(san) {
    // Clean
    const orig = san;
    san = san.replace(/[+#!?]/g,'');

    const color = this.turn;
    const opp   = color === 'w' ? 'b' : 'w';

    // Castling
    if (san === 'O-O' || san === '0-0') {
      return this._castle(color, 'K');
    }
    if (san === 'O-O-O' || san === '0-0-0') {
      return this._castle(color, 'Q');
    }

    // Parse SAN
    let piece = 'P';
    let promotion = null;
    let toSq = null;
    let fromFile = null;
    let fromRank = null;

    let s = san;

    // Promotion
    const promMatch = s.match(/=?([QRBN])$/);
    if (promMatch) {
      promotion = promMatch[1];
      s = s.slice(0, s.length - promMatch[0].length);
    }

    // Piece letter
    if (/^[KQRBN]/.test(s)) {
      piece = s[0];
      s = s.slice(1);
    }

    // Capture x
    s = s.replace('x','');

    // Now s should be: [file][rank]toFile toRank or just toFiltoRank
    // toSq is last 2 chars
    if (s.length >= 2) {
      toSq = s.slice(-2);
      const disambig = s.slice(0, s.length-2);
      if (disambig.length === 1) {
        if (/[a-h]/.test(disambig)) fromFile = disambig;
        else if (/[1-8]/.test(disambig)) fromRank = disambig;
      } else if (disambig.length === 2) {
        fromFile = disambig[0];
        fromRank = disambig[1];
      }
    } else {
      console.warn('Cannot parse SAN:', orig);
      return false;
    }

    // Find candidate piece on board
    const candidates = [];
    for (let i=0;i<64;i++) {
      const p = this.board[i];
      if (!p || p[0] !== color || p[1] !== piece) continue;
      const sq = idxToSq(i);
      if (fromFile && sq[0] !== fromFile) continue;
      if (fromRank && sq[1] !== fromRank) continue;
      if (this._canMove(sq, toSq, piece, color)) {
        candidates.push(sq);
      }
    }

    if (candidates.length === 0) {
      console.warn('No candidate for', orig, 'turn', color);
      return false;
    }
    if (candidates.length > 1) {
      console.warn('Multiple candidates for', orig, candidates);
    }

    const fromSq = candidates[0];
    this._doMove(fromSq, toSq, piece, color, promotion);
    this.turn = opp;
    if (opp === 'w') this.fullmove++;
    return true;
  }

  _canMove(from, to, piece, color) {
    // Check pseudo-legal move, then verify not in check
    if (!this._pseudoLegal(from, to, piece, color)) return false;
    const test = this.clone();
    test._doMove(from, to, piece, color, 'Q'); // promotion doesn't matter for check
    test.turn = color; // keep same turn to check own king
    return !test._inCheck(color);
  }

  _pseudoLegal(from, to, piece, color) {
    const ff = f(from), fr = r(from);
    const tf = f(to),   tr = r(to);
    const df = tf-ff, dr = tr-fr;
    const target = this.get(to);
    if (target && target[0] === color) return false; // can't capture own piece

    const opp = color==='w'?'b':'w';

    if (piece === 'P') {
      const dir = color==='w' ? 1 : -1;
      const startRank = color==='w' ? 1 : 6;
      if (df === 0) {
        if (dr === dir && !target) return true;
        if (dr === 2*dir && fr === startRank && !target && !this.get(FILES[ff]+RANKS[fr+dir])) return true;
      } else if (Math.abs(df)===1 && dr===dir) {
        if (target && target[0]===opp) return true;
        if (to === this.ep) return true;
      }
      return false;
    }

    if (piece === 'N') {
      return (Math.abs(df)===2&&Math.abs(dr)===1)||(Math.abs(df)===1&&Math.abs(dr)===2);
    }

    if (piece === 'K') {
      return Math.abs(df)<=1 && Math.abs(dr)<=1 && (df!==0||dr!==0);
    }

    if (piece === 'R' || piece === 'Q') {
      if (df===0||dr===0) {
        if (this._pathClear(from,to)) return true;
      }
    }
    if (piece === 'B' || piece === 'Q') {
      if (Math.abs(df)===Math.abs(dr)) {
        if (this._pathClear(from,to)) return true;
      }
    }
    return false;
  }

  _pathClear(from, to) {
    const ff = f(from), fr = r(from);
    const tf = f(to),   tr = r(to);
    const sf = Math.sign(tf-ff), sr = Math.sign(tr-fr);
    let cf = ff+sf, cr = fr+sr;
    while (cf!==tf || cr!==tr) {
      if (this.board[cf+cr*8]) return false;
      cf+=sf; cr+=sr;
    }
    return true;
  }

  _doMove(from, to, piece, color, promotion) {
    const opp = color==='w'?'b':'w';
    const tf = f(to), tr = r(to);
    const ff2 = f(from), fr2 = r(from);

    // En passant capture
    if (piece==='P' && to===this.ep && ff2!==tf) {
      const capRank = color==='w' ? tr-1 : tr+1;
      this.board[tf+capRank*8] = null;
    }

    // Set en passant
    this.ep = null;
    const dr = tr - fr2;
    if (piece==='P' && Math.abs(dr)===2) {
      this.ep = FILES[ff2] + RANKS[fr2+Math.sign(dr)];
    }

    // Move piece
    const movingPiece = this.board[ff2+fr2*8];
    this.board[tf+tr*8] = movingPiece;
    this.board[ff2+fr2*8] = null;

    // Promotion
    if (piece==='P' && (tr===7||tr===0) && promotion) {
      this.board[tf+tr*8] = color+promotion;
    }

    // Update castling rights
    if (piece==='K') { this.castling[color+'K']=false; this.castling[color+'Q']=false; }
    if (from==='a1'||to==='a1') this.castling['wQ']=false;
    if (from==='h1'||to==='h1') this.castling['wK']=false;
    if (from==='a8'||to==='a8') this.castling['bQ']=false;
    if (from==='h8'||to==='h8') this.castling['bK']=false;
  }

  _castle(color, side) {
    const opp = color==='w'?'b':'w';
    const rank = color==='w'?'1':'8';
    if (side==='K') {
      if (!this.castling[color+'K']) return false;
      const path = [FILES[5]+rank, FILES[6]+rank];
      for (const sq of path) if (this.get(sq)) return false;
      // Check not in check on path
      for (const sq of [FILES[4]+rank, ...path]) {
        const test = this.clone();
        test.board[sqToIdx(sq)] = color+'K';
        test.board[sqToIdx(FILES[4]+rank)] = null;
        test.turn = color;
        if (test._inCheck(color)) return false;
      }
      this.set(FILES[4]+rank, null);
      this.set(FILES[7]+rank, null);
      this.set(FILES[6]+rank, color+'K');
      this.set(FILES[5]+rank, color+'R');
    } else {
      if (!this.castling[color+'Q']) return false;
      const path = [FILES[3]+rank, FILES[2]+rank, FILES[1]+rank];
      for (const sq of path) if (this.get(sq)) return false;
      for (const sq of [FILES[4]+rank, FILES[3]+rank, FILES[2]+rank]) {
        const test = this.clone();
        test.board[sqToIdx(sq)] = color+'K';
        test.board[sqToIdx(FILES[4]+rank)] = null;
        test.turn = color;
        if (test._inCheck(color)) return false;
      }
      this.set(FILES[4]+rank, null);
      this.set(FILES[0]+rank, null);
      this.set(FILES[2]+rank, color+'K');
      this.set(FILES[3]+rank, color+'R');
    }
    this.castling[color+'K']=false;
    this.castling[color+'Q']=false;
    this.turn = opp;
    if (opp==='w') this.fullmove++;
    return true;
  }

  _inCheck(color) {
    // Find king
    let kingSq = null;
    for (let i=0;i<64;i++) {
      if (this.board[i]===color+'K') { kingSq=idxToSq(i); break; }
    }
    if (!kingSq) return false;
    const opp = color==='w'?'b':'w';
    for (let i=0;i<64;i++) {
      const p = this.board[i];
      if (!p||p[0]!==opp) continue;
      const sq = idxToSq(i);
      if (this._pseudoLegal(sq, kingSq, p[1], opp)) return true;
    }
    return false;
  }
}

// ═══════════════════════════════════════════════════════
//  UI STATE
// ═══════════════════════════════════════════════════════
let allGames = [];
let currentGame = null;   // { tags, moves }
let positions = [];       // positions[i] = Chess state after i moves
let moveIndex = 0;        // 0 = starting position, N = after N moves
let lastFrom = null, lastTo = null;


// ═══════════════════════════════════════════════════════
//  STOCKFISH ENGINE
// ═══════════════════════════════════════════════════════
let sfWorker      = null;   // Web Worker running Stockfish
let sfAnalysing   = false;  // toggle state
let sfCurrentFen  = null;   // FEN we last sent
let sfBestMove    = null;   // e.g. 'e2e4'
let sfPonderMove  = null;

function fenFromPosition(chess) {
  // Build FEN string from our Chess object
  let fen = '';
  for (let rank = 7; rank >= 0; rank--) {
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const p = chess.board[file + rank * 8];
      if (!p) { empty++; continue; }
      if (empty) { fen += empty; empty = 0; }
      const letter = p[1] === 'N' ? 'n' : p[1].toLowerCase();
      fen += p[0] === 'w' ? letter.toUpperCase() : letter;
    }
    if (empty) fen += empty;
    if (rank > 0) fen += '/';
  }
  // Active color
  fen += ' ' + chess.turn;
  // Castling
  let cast = '';
  if (chess.castling.wK) cast += 'K';
  if (chess.castling.wQ) cast += 'Q';
  if (chess.castling.bK) cast += 'k';
  if (chess.castling.bQ) cast += 'q';
  fen += ' ' + (cast || '-');
  // En passant
  fen += ' ' + (chess.ep || '-');
  // Halfmove / fullmove
  fen += ' ' + chess.halfmove + ' ' + chess.fullmove;
  return fen;
}

function initStockfish() {
  if (sfWorker) return; // already running
  try {
    sfWorker = new Worker('./stockfish.js');
    sfWorker.onmessage = e => handleSfMessage(e.data);
    sfWorker.onerror   = e => console.error('[stockfish] worker error:', e);
    sfWorker.postMessage('uci');
    sfWorker.postMessage('isready');
    console.log('[stockfish] worker started');
  } catch(err) {
    console.error('[stockfish] failed to start:', err);
    sfWorker = null;
    alert('Could not load Stockfish. Make sure stockfish.js is in the viewer/ folder.');
  }
}

function handleSfMessage(msg) {
  // info depth 18 ... score cp 34 ... pv e2e4 ...
  // info depth 18 ... score mate 3 ... pv ...
  // bestmove e2e4 ponder c7c5

  if (msg.startsWith('info') && msg.includes('score') && msg.includes(' pv ')) {
    const depthM  = msg.match(/depth (\d+)/);
    const cpM     = msg.match(/score cp (-?\d+)/);
    const mateM   = msg.match(/score mate (-?\d+)/);
    const pvM     = msg.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/);
    const depth   = depthM  ? parseInt(depthM[1])  : 0;
    const target  = SETTINGS.analyseDepth ?? 18;

    // Only update display at target depth (or final info line)
    if (depth < target - 2) return;

    let cp = null;
    if (mateM) {
      const m = parseInt(mateM[1]);
      cp = m > 0 ? 9999 : -9999;
    } else if (cpM) {
      cp = parseInt(cpM[1]);
    }

    // Flip score if it's black to move (engine always reports from side-to-move POV)
    if (sfCurrentFen && sfCurrentFen.split(' ')[1] === 'b') {
      if (cp !== null) cp = -cp;
    }

    if (cp !== null) updateEvalBar(cp);
    if (pvM) {
      sfBestMove = pvM[1];
      drawArrows();
    }
  }

  if (msg.startsWith('bestmove')) {
    const parts = msg.split(' ');
    sfBestMove  = parts[1] !== '(none)' ? parts[1] : null;
    sfPonderMove = parts[3] || null;
    drawArrows();
  }
}

function analysePosition() {
  if (!sfWorker || !sfAnalysing) return;
  const chess = positions[moveIndex];
  if (!chess) return;

  sfBestMove = null;
  clearArrows();

  const fen = fenFromPosition(chess);
  sfCurrentFen = fen;
  const depth = SETTINGS.analyseDepth ?? 18;

  sfWorker.postMessage('stop');
  sfWorker.postMessage(`position fen ${fen}`);
  sfWorker.postMessage(`go depth ${depth}`);
}

function toggleAnalyse() {
  const btn = document.getElementById('btnAnalyse');
  sfAnalysing = !sfAnalysing;
  btn.classList.toggle('active', sfAnalysing);

  if (sfAnalysing) {
    initStockfish();
    analysePosition();
  } else {
    if (sfWorker) sfWorker.postMessage('stop');
    clearEvalBar();
    clearArrows();
  }
}

// ═══════════════════════════════════════════════════════
//  EVAL BAR
// ═══════════════════════════════════════════════════════
// Scale: ±12 pawns = full bar (1 square = 3 pawns as requested)
const EVAL_MAX_CP = 1200; // centipawns at which bar is full

function updateEvalBar(cp) {
  // Clamp to ±EVAL_MAX_CP
  const clamped = Math.max(-EVAL_MAX_CP, Math.min(EVAL_MAX_CP, cp));
  // white% = 50 + (cp / EVAL_MAX_CP) * 50
  const whitePct = 50 + (clamped / EVAL_MAX_CP) * 50;
  const blackPct = 100 - whitePct;

  document.getElementById('evalBarWhite').style.flex = whitePct.toString();
  document.getElementById('evalBarBlack').style.flex = blackPct.toString();

  // Score label
  let label;
  if (cp >= 9999)       label = 'M';          // white mates
  else if (cp <= -9999) label = 'M';          // black mates
  else {
    const abs = Math.abs(cp / 100).toFixed(1);
    label = (cp >= 0 ? '+' : '−') + abs;
  }
  document.getElementById('evalScore').textContent = label;
}

function clearEvalBar() {
  document.getElementById('evalBarWhite').style.flex = '50';
  document.getElementById('evalBarBlack').style.flex = '50';
  document.getElementById('evalScore').textContent = '—';
}

// ═══════════════════════════════════════════════════════
//  ARROWS
// ═══════════════════════════════════════════════════════
function sqCenter(sqName) {
  // Returns {x, y} pixel centre of a square on the 512×512 board
  const file = FILES.indexOf(sqName[0]);
  const rank = parseInt(sqName[1]) - 1;
  return {
    x: file * 64 + 32,
    y: (7 - rank) * 64 + 32
  };
}

function makeArrow(fromSq, toSq, color, opacity) {
  const from = sqCenter(fromSq);
  const to   = sqCenter(toSq);

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx*dx + dy*dy);
  const ux = dx/len, uy = dy/len;

  // Shorten tail and head so arrow sits inside squares
  const tailOffset = 12;
  const headOffset = 18;
  const x1 = from.x + ux * tailOffset;
  const y1 = from.y + uy * tailOffset;
  const x2 = to.x   - ux * headOffset;
  const y2 = to.y   - uy * headOffset;

  // Arrow shaft
  const shaft = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  shaft.setAttribute('x1', x1); shaft.setAttribute('y1', y1);
  shaft.setAttribute('x2', x2); shaft.setAttribute('y2', y2);
  shaft.setAttribute('stroke', color);
  shaft.setAttribute('stroke-width', '8');
  shaft.setAttribute('stroke-linecap', 'round');
  shaft.setAttribute('opacity', opacity);

  // Arrowhead (triangle)
  const ang = Math.atan2(dy, dx);
  const hw = 14, hl = 20; // head width, length
  const tip = { x: to.x - ux*4, y: to.y - uy*4 };
  const lx = tip.x - hl*Math.cos(ang) + hw*Math.sin(ang);
  const ly = tip.y - hl*Math.sin(ang) - hw*Math.cos(ang);
  const rx = tip.x - hl*Math.cos(ang) - hw*Math.sin(ang);
  const ry = tip.y - hl*Math.sin(ang) + hw*Math.cos(ang);

  const head = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  head.setAttribute('points', `${tip.x},${tip.y} ${lx},${ly} ${rx},${ry}`);
  head.setAttribute('fill', color);
  head.setAttribute('opacity', opacity);

  return [shaft, head];
}

function drawArrows() {
  clearArrows();
  const svg = document.getElementById('arrowLayer');
  if (!svg) return;

  // Played move (lastFrom -> lastTo)
  const playedFrom = lastFrom;
  const playedTo   = lastTo;

  // Best move from engine
  const bestFrom = sfBestMove ? sfBestMove.slice(0,2) : null;
  const bestTo   = sfBestMove ? sfBestMove.slice(2,4) : null;

  const sameMove = bestFrom && playedFrom &&
                   bestFrom === playedFrom && bestTo === playedTo;

  if (sameMove) {
    // Gold: played move was the best move
    makeArrow(playedFrom, playedTo, '#c9a84c', '0.85').forEach(el => svg.appendChild(el));
  } else {
    // Blue: played move
    if (playedFrom && playedTo) {
      makeArrow(playedFrom, playedTo, '#4a90d9', '0.75').forEach(el => svg.appendChild(el));
    }
    // Green: best move
    if (bestFrom && bestTo) {
      makeArrow(bestFrom, bestTo, '#4caf50', '0.85').forEach(el => svg.appendChild(el));
    }
  }
}

function clearArrows() {
  const svg = document.getElementById('arrowLayer');
  if (svg) svg.innerHTML = '';
}

// ═══════════════════════════════════════════════════════
//  BUILD BOARD DOM
// ═══════════════════════════════════════════════════════
function buildBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  // Ranks 8..1, files a..h
  for (let rank=7; rank>=0; rank--) {
    for (let file=0; file<8; file++) {
      const isLight = (file+rank)%2!==0;
      const div = document.createElement('div');
      const sqName = FILES[file]+RANKS[rank];
      div.className = 'sq ' + (isLight ? 'light' : 'dark');
      div.id = 'sq-'+sqName;
      div.style.backgroundImage = `url('${squareUrl(isLight)}')`;
      div.style.backgroundSize = '100% 100%';
      board.appendChild(div);
    }
  }

  // Rank coords
  const rankC = document.getElementById('rankCoords');
  rankC.innerHTML = '';
  for (let rank=7;rank>=0;rank--) {
    const s = document.createElement('span');
    s.className='coord';
    s.textContent = rank+1;
    rankC.appendChild(s);
  }

  // File coords
  const fileC = document.getElementById('fileCoords');
  fileC.innerHTML = '';
  for (let file=0;file<8;file++) {
    const s = document.createElement('span');
    s.className='coord';
    s.textContent = FILES[file];
    fileC.appendChild(s);
  }
}

function renderBoard(chess) {
  for (let i=0;i<64;i++) {
    const sqName = idxToSq(i);
    const el = document.getElementById('sq-'+sqName);
    if (!el) continue;

    // Highlight overlay — semi-transparent color on top of bitmap
    const isHi = (sqName===lastFrom||sqName===lastTo);
    const isLight = (file=>rank=>(file+rank)%2!==0)(i%8)(Math.floor(i/8));
    el.className = 'sq ' + (isLight ? 'light' : 'dark');

    const highlightDiv = isHi
      ? `<div style="position:absolute;inset:0;background:${isLight ? 'rgba(205,210,50,0.5)' : 'rgba(170,162,58,0.6)'};pointer-events:none;"></div>`
      : '';

    const piece = chess.board[i];
    const pieceImg = piece
      ? `<img src="${pieceUrl(piece)}" style="position:relative;width:90%;height:90%;display:block;margin:auto;pointer-events:none;" draggable="false">`
      : '';

    el.innerHTML = highlightDiv + pieceImg;
  }
}

// ═══════════════════════════════════════════════════════
//  LOAD GAME
// ═══════════════════════════════════════════════════════
function buildPositions(moves) {
  const states = [];
  const chess = new Chess();
  states.push(chess.clone());
  lastFrom = null; lastTo = null;
  const froms = [null];
  const tos   = [null];

  for (const move of moves) {
    // Try to detect from/to before applying (hack: check where pieces are)
    // We'll record from/to after the fact by comparing boards
    const before = chess.board.slice();
    const ok = chess.applySAN(move);
    if (!ok) {
      console.warn('Failed to apply move:', move);
      break;
    }
    // Find changed squares
    let fromSq=null, toSq=null;
    const after = chess.board.slice();
    for (let i=0;i<64;i++) {
      if (before[i]!==after[i]) {
        if (before[i] && !after[i] && !fromSq) fromSq=idxToSq(i);
        else if (after[i] && !before[i]) toSq=idxToSq(i);
        else if (after[i] && before[i] && before[i]!==after[i]) toSq=idxToSq(i);
      }
    }
    // Castling fix: multiple squares change
    froms.push(fromSq);
    tos.push(toSq);
    states.push(chess.clone());
  }
  return { states, froms, tos };
}

function loadGame(idx) {
  const game = allGames[idx];
  if (!game) return;
  currentGame = game;

  // Build all positions
  const { states, froms, tos } = buildPositions(game.moves);
  positions = states;
  window._froms = froms;
  window._tos   = tos;

  moveIndex = 0;
  lastFrom = null; lastTo = null;

  renderBoard(positions[0]);
  clearArrows();
  clearEvalBar();
  updateMoveList();
  updateInfo();
  updateControls();

  document.getElementById('boardWrap').style.display='';
  document.getElementById('controls').style.display='flex';
  document.getElementById('kbHint').style.display='';
  document.getElementById('loadMsg').style.display='none';
}


function showResultPopup(text) {
  const popup = document.getElementById('resultPopup');
  const inner = document.getElementById('popupInner');
  inner.textContent = text;
  popup.classList.add('show');
  setTimeout(() => popup.classList.remove('show'), SETTINGS.popupDuration ?? 1500);
}

function goToMove(idx, silent=false) {
  if (idx<0||idx>=positions.length) return;
  const wasAtEnd = moveIndex === positions.length-1;
  moveIndex = idx;
  lastFrom = window._froms[idx]||null;
  lastTo   = window._tos[idx]||null;
  renderBoard(positions[moveIndex]);
  updateControls();
  highlightMoveInList(moveIndex);
  updateStatus();
  // Show result popup when stepping onto the last move (not when jumping directly)
  if (!silent && !wasAtEnd && moveIndex === positions.length-1 && currentGame) {
    const result = currentGame.tags.Result || '*';
    const text = result === '1-0' ? 'White wins' :
                 result === '0-1' ? 'Black wins' :
                 result === '1/2-1/2' ? '½ – ½' : '∗';
    showResultPopup(text);
  }
  // Trigger engine analysis if active
  if (sfAnalysing) analysePosition();
  else drawArrows(); // still draw played-move arrow
}

function updateControls() {
  document.getElementById('btnStart').disabled = moveIndex===0;
  document.getElementById('btnPrev').disabled  = moveIndex===0;
  document.getElementById('btnNext').disabled  = moveIndex>=positions.length-1;
  document.getElementById('btnEnd').disabled   = moveIndex>=positions.length-1;
  const total = positions.length-1;
  const mn = Math.ceil(moveIndex/2);
  document.getElementById('moveCtr').textContent =
    moveIndex===0 ? 'Start' : `Move ${moveIndex} / ${total}`;
  updateStatus();
}

function updateStatus() {
  const el = document.getElementById('status');
  if (!currentGame) return;
  if (moveIndex===0) { el.textContent=''; return; }
  const chess = positions[moveIndex];
  const inCheck = chess._inCheck(chess.turn);
  if (moveIndex===positions.length-1) {
    const result = currentGame.tags.Result||'*';
    if (result==='1-0') el.textContent='White wins';
    else if (result==='0-1') el.textContent='Black wins';
    else if (result==='1/2-1/2') el.textContent='Draw';
    else el.textContent = inCheck ? (chess.turn==='w'?'Black wins':'White wins') : '';
  } else {
    el.textContent = inCheck ? (chess.turn==='w'?'White is in check':'Black is in check') : '';
  }
}

// ═══════════════════════════════════════════════════════
//  MOVE LIST
// ═══════════════════════════════════════════════════════
function updateMoveList() {
  const container = document.getElementById('moveList');
  container.innerHTML = '';
  if (!currentGame) return;

  const moves = currentGame.moves;
  for (let i=0;i<moves.length;i++) {
    if (i%2===0) {
      const num = document.createElement('span');
      num.className='move-num';
      num.textContent = (i/2+1)+'.';
      container.appendChild(num);
    }
    const tok = document.createElement('span');
    tok.className='move-token';
    tok.textContent=moves[i];
    tok.dataset.idx = i+1;
    tok.onclick = () => goToMove(i+1);
    container.appendChild(tok);
  }

  // Result
  if (currentGame.tags.Result && currentGame.tags.Result!=='*') {
    const res = document.createElement('span');
    res.className='result-badge';
    res.style.marginLeft='6px';
    res.textContent=currentGame.tags.Result;
    container.appendChild(res);
  }
}

function highlightMoveInList(idx) {
  document.querySelectorAll('.move-token').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.idx)===idx);
    if (parseInt(el.dataset.idx)===idx) {
      el.scrollIntoView({block:'nearest',behavior:'smooth'});
    }
  });
}

// ═══════════════════════════════════════════════════════
//  GAME INFO
// ═══════════════════════════════════════════════════════
function updateInfo() {
  if (!currentGame) return;
  const tags = currentGame.tags;
  const rows = document.getElementById('infoRows');
  rows.innerHTML='';

  const show = [
    ['White', tags.White],
    ['Black', tags.Black],
    ['Date',  tags.Date],
    ['Event', tags.Event],
    ['Round', tags.Round],
    ['Result',tags.Result],
    ['ECO',   tags.ECO],
    ['Opening', tags.Opening],
  ];

  for (const [label,val] of show) {
    if (!val||val==='?'||val==='??'||val==='???') continue;
    const div = document.createElement('div');
    div.className='info-row';
    if (label==='Result') {
      div.innerHTML=`<span class="info-label">${label}</span><span class="result-badge">${val}</span>`;
    } else {
      div.innerHTML=`<span class="info-label">${label}</span><span class="info-val">${val}</span>`;
    }
    rows.appendChild(div);
  }

  // URL row — always last
  const gameNumber = parseInt(document.getElementById('gameSelect').value) + 1;
  const pgnIdx     = parseInt(document.getElementById('pgnSelect').value) || 0;
  const url = `${location.origin}${location.pathname}?pgn=${pgnIdx}&game=${gameNumber}`;
  const urlDiv = document.createElement('div');
  urlDiv.className = 'info-row';
  urlDiv.style.marginTop = '8px';
  urlDiv.style.borderTop = '1px solid var(--border)';
  urlDiv.style.paddingTop = '8px';
  urlDiv.innerHTML = `<span class="info-label">Link</span><span class="info-val"><a href="${url}" id="gameLink" style="color:var(--gold);text-decoration:none;font-size:0.83rem">Link to this game</a></span>`;
  rows.appendChild(urlDiv);

  // One-click copy button
  const copyDiv = document.createElement('div');
  copyDiv.className = 'info-row';
  copyDiv.innerHTML = `<span></span><button onclick="navigator.clipboard.writeText('${url}').then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy link',1500)})" style="background:var(--surface);border:1px solid var(--border);color:var(--gold);padding:3px 10px;border-radius:3px;cursor:pointer;font-size:0.75rem">Copy link</button>`;
  rows.appendChild(copyDiv);
}

// ═══════════════════════════════════════════════════════
//  PGN FILE SELECTOR
// ═══════════════════════════════════════════════════════
function populatePgnSelector(selectedIdx) {
  const sel = document.getElementById('pgnSelect');
  sel.innerHTML = '';
  (SETTINGS.pgnFiles || []).forEach((f, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = f.label || f.file;
    sel.appendChild(opt);
  });
  sel.value = selectedIdx || 0;
  sel.onchange = () => loadPgn(parseInt(sel.value));
}

async function loadPgn(fileIdx) {
  const files = SETTINGS.pgnFiles || [];
  const entry = files[fileIdx];
  if (!entry) return;

  const loadMsg = document.getElementById('loadMsg');
  loadMsg.style.display = '';
  loadMsg.textContent = 'Loading…';

  // Hide board while loading new file
  document.getElementById('boardWrap').style.display = 'none';
  document.getElementById('controls').style.display  = 'none';
  document.getElementById('kbHint').style.display    = 'none';

  try {
    const resp = await fetch(entry.file);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf  = await resp.arrayBuffer();
    const text = new TextDecoder('windows-1252').decode(buf);

    allGames = parsePGN(text);
    if (allGames.length === 0) throw new Error('No games found in PGN');
    console.log('[PGN] Loaded', allGames.length, 'games from', entry.file);

    loadMsg.style.display = 'none';
    populateSelector();

    // Honour ?game= param only on initial load (fileIdx from URL)
    const params = new URLSearchParams(window.location.search);
    const pgnParam  = params.get('pgn');
    const gameParam = params.get('game');
    const fromUrl   = pgnParam !== null && parseInt(pgnParam) === fileIdx;
    const gameIdx   = fromUrl && gameParam
      ? Math.min(Math.max(parseInt(gameParam) - 1, 0), allGames.length - 1)
      : 0;

    loadGame(gameIdx);
    document.getElementById('gameSelect').value = gameIdx;

  } catch(err) {
    loadMsg.innerHTML = `<strong style="color:#c44">Could not load PGN.</strong><br>
      <small style="color:var(--muted)">${err.message}</small>`;
  }
}

// ═══════════════════════════════════════════════════════
//  GAME SELECTOR
// ═══════════════════════════════════════════════════════
function populateSelector() {
  const sel = document.getElementById('gameSelect');
  sel.innerHTML='';
  allGames.forEach((g,i) => {
    const opt = document.createElement('option');
    const w = g.tags.White||'?';
    const b = g.tags.Black||'?';
    const d = (g.tags.Date||'').replace(/\.\?\?/,'').replace(/\?/g,'');
    const r = g.tags.Result||'';
    opt.value=i;
    opt.textContent=`${i+1}. ${w} vs ${b}${d?' ('+d+')':''}  ${r}`;
    sel.appendChild(opt);
  });
  sel.onchange = () => loadGame(parseInt(sel.value));
}

// ═══════════════════════════════════════════════════════
//  FETCH & INIT
// ═══════════════════════════════════════════════════════
async function init() {
  document.getElementById('buildBadge').textContent = BUILD;
  await loadSettings();
  buildBoard();

  // Determine which PGN file to load — honour ?pgn= URL param
  const params   = new URLSearchParams(window.location.search);
  const pgnParam = params.get('pgn');
  const files    = SETTINGS.pgnFiles || [];
  const fileIdx  = pgnParam !== null
    ? Math.min(Math.max(parseInt(pgnParam), 0), files.length - 1)
    : 0;

  populatePgnSelector(fileIdx);
  await loadPgn(fileIdx);
}

// ═══════════════════════════════════════════════════════
//  BUTTON WIRING
// ═══════════════════════════════════════════════════════
document.getElementById('btnAnalyse').onclick = toggleAnalyse;
document.getElementById('btnStart').onclick = () => goToMove(0);
document.getElementById('btnPrev').onclick  = () => goToMove(moveIndex-1);
document.getElementById('btnNext').onclick  = () => goToMove(moveIndex+1);
document.getElementById('btnEnd').onclick   = () => goToMove(positions.length-1, true);

document.addEventListener('keydown', e => {
  if (!currentGame) return;
  if (e.key==='ArrowRight'||e.key==='ArrowDown') { e.preventDefault(); goToMove(moveIndex+1); }
  if (e.key==='ArrowLeft' ||e.key==='ArrowUp')   { e.preventDefault(); goToMove(moveIndex-1); }
  if (e.key==='Home') { e.preventDefault(); goToMove(0); }
  if (e.key==='End')  { e.preventDefault(); goToMove(positions.length-1); }
});

init();
