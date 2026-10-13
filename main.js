console.log("MAIN.JS HAS LOADED");

import { Chess } from './node_modules/chess.js/dist/esm/chess.js';
import { Chessground } from './node_modules/@lichess-org/chessground/dist/chessground.js';

import {
    initEngine,
    getBestMove,
    getEngineElo,
    prepareBlackBlindPlan,
    getBlackBlindMove,
    clearBlackBlindPlan
} from './engine.js';

const HUMAN_COLOR = 'w';
const ENGINE_COLOR = 'b';

const actualGame = new Chess();
const visibleGame = new Chess();

let whiteMovesCompleted = 0;
let blackMovesCompleted = 0;

let blindMoveActive = false;
let blindMoveColor = null;

let engineThinking = false;

const moveHistory = [];

const boardElement = document.getElementById('board');

const ground = Chessground(boardElement, {
    orientation: 'white',
    fen: visibleGame.fen(),
    coordinates: true,

    movable: {
        free: false,
        color: 'white',
        dests: new Map(),
        showDests: true
    },

    events: {
        move: (from, to) => {
            handleBoardMove(from, to);
        }
    }
});

function setStatus(message) {
    const statusElement = document.getElementById('status');

    if (statusElement) {
        statusElement.textContent = message;
    }
}

function uciToMoveObject(uci) {
    if (!uci || uci.length < 4) {
        return null;
    }

    return {
        from: uci.substring(0, 2),
        to: uci.substring(2, 4),
        promotion: uci.length >= 5
            ? uci.substring(4, 5)
            : undefined
    };
}

const ALL_SQUARES = [];

for (const file of 'abcdefgh') {
    for (let rank = 1; rank <= 8; rank++) {
        ALL_SQUARES.push(`${file}${rank}`);
    }
}

function getLegalDestinations(game) {
    const destinations = new Map();

    const moves = game.moves({
        verbose: true
    });

    for (const move of moves) {
        if (!destinations.has(move.from)) {
            destinations.set(move.from, []);
        }

        destinations.get(move.from).push(move.to);
    }

    return destinations;
}

function getBlindDestinations(color) {
    const destinations = new Map();

    for (const square of ALL_SQUARES) {
        const piece = visibleGame.get(square);

        if (!piece) {
            continue;
        }

        if (piece.color !== color) {
            continue;
        }

        destinations.set(
            square,
            [...ALL_SQUARES]
        );
    }

    return destinations;
}

function shouldNextMoveBeBlind() {
    const nextPlayer = actualGame.turn();

    if (nextPlayer === 'w') {
        const nextMoveNumber =
            whiteMovesCompleted + 1;

        return nextMoveNumber % 10 === 5;
    }

    const nextMoveNumber =
        blackMovesCompleted + 1;

    return nextMoveNumber % 10 === 0;
}

function shouldPrepareBlackBlindPlan() {
    const nextBlackMove =
        blackMovesCompleted + 1;

    return (
        nextBlackMove >= 10 &&
        nextBlackMove % 10 === 0
    );
}

function getPromotion(from, to) {
    const piece = visibleGame.get(from);

    if (!piece) {
        return undefined;
    }

    if (piece.type !== 'p') {
        return undefined;
    }

    if (to.endsWith('8') || to.endsWith('1')) {
        return 'q';
    }

    return undefined;
}

function addMoveAnnotation(move, isBlind = false) {
    const moveNumber =
        move.color === 'w'
            ? whiteMovesCompleted
            : blackMovesCompleted;

    moveHistory.push({
        number: moveNumber,
        color: move.color,
        san: move.san,
        blind: isBlind,
        hidden: false
    });

    renderMoveAnnotation();
}

function hideLastMoveAnnotation() {
    if (moveHistory.length === 0) {
        return;
    }

    const lastMove =
        moveHistory[moveHistory.length - 1];

    lastMove.hidden = true;

    renderMoveAnnotation();
}

function revealHiddenMoves() {
    for (const move of moveHistory) {
        move.hidden = false;
    }

    renderMoveAnnotation();
}

function renderMoveAnnotation() {
    const moveList =
        document.getElementById('move-list');

    if (!moveList) {
        return;
    }

    moveList.innerHTML = '';

    const rows = new Map();

    for (
        let index = 0;
        index < moveHistory.length;
        index++
    ) {
        const move = moveHistory[index];

        if (!rows.has(move.number)) {
            rows.set(move.number, {
                number: move.number,
                white: null,
                black: null
            });
        }

        const row = rows.get(move.number);

        if (move.color === 'w') {
            row.white = {
                move,
                index
            };
        } else {
            row.black = {
                move,
                index
            };
        }
    }

    const rowArray =
        Array.from(rows.values()).reverse();

    for (const rowData of rowArray) {
        const row =
            document.createElement('div');

        row.className = 'move-row';

        const numberCell =
            document.createElement('div');

        numberCell.className = 'move-number';

        numberCell.textContent =
            `${rowData.number}.`;

        row.appendChild(numberCell);

        const whiteCell =
            document.createElement('div');

        whiteCell.className = 'move-cell';

        if (rowData.white) {
            const move =
                rowData.white.move;

            if (move.blind) {
                whiteCell.classList.add('blind-move');
            }

            if (move.hidden) {
                whiteCell.classList.add(
                    'hidden-move'
                );

                whiteCell.textContent = '???';
            } else {
                whiteCell.textContent =
                    move.san;
            }
        }

        row.appendChild(whiteCell);

        const blackCell =
            document.createElement('div');

        blackCell.className = 'move-cell';

        if (rowData.black) {
            const move =
                rowData.black.move;

            if (move.blind) {
                blackCell.classList.add('blind-move');
            }

            if (move.hidden) {
                blackCell.classList.add(
                    'hidden-move'
                );

                blackCell.textContent = '???';
            } else {
                blackCell.textContent =
                    move.san;
            }
        }

        row.appendChild(blackCell);

        moveList.appendChild(row);
    }

    moveList.scrollTop = 0;
}

function handleBoardMove(from, to) {
    if (engineThinking) {
        return;
    }

    if (blindMoveActive) {
        handleBlindMove(from, to);
        return;
    }

    handleNormalMove(from, to);
}

function handleNormalMove(from, to) {
    if (actualGame.turn() !== HUMAN_COLOR) {
        updateBoard();
        return;
    }

    const promotion =
        getPromotion(from, to);

    let move;

    try {
        move = actualGame.move({
            from,
            to,
            promotion
        });
    } catch (error) {
        console.log(
            'Illegal move:',
            error
        );

        updateBoard();
        return;
    }

    if (move.color === 'w') {
        whiteMovesCompleted++;
    } else {
        blackMovesCompleted++;
    }

    addMoveAnnotation(
        move,
        false
    );

    if (actualGame.isGameOver()) {
        visibleGame.load(
            actualGame.fen()
        );

        updateBoard();

        showGameResult();

        return;
    }

    continueAfterMove();
}

function handleBlindMove(from, to) {
    if (!blindMoveActive) {
        return;
    }

    if (blindMoveColor !== HUMAN_COLOR) {
        return;
    }

    const visiblePiece =
        visibleGame.get(from);

    if (!visiblePiece) {
        setStatus(
            'That square is empty on the visible board.'
        );

        updateBoard();
        return;
    }

    if (visiblePiece.color !== blindMoveColor) {
        setStatus(
            'You can only move your own pieces.'
        );

        updateBoard();
        return;
    }

    const promotion =
        getPromotion(from, to);

    const testGame =
        new Chess(actualGame.fen());

    try {
        testGame.move({
            from,
            to,
            promotion
        });
    } catch (error) {
        setStatus(
            'That move is illegal in the hidden position. Try again.'
        );

        updateBoard();
        return;
    }

    let realMove;

    try {
        realMove = actualGame.move({
            from,
            to,
            promotion
        });
    } catch (error) {
        console.error(
            'Unexpected blind move commit error:',
            error
        );

        updateBoard();
        return;
    }

    if (realMove.color === 'w') {
        whiteMovesCompleted++;
    } else {
        blackMovesCompleted++;
    }

    addMoveAnnotation(
        realMove,
        true
    );

    revealHiddenMoves();

    blindMoveActive = false;
    blindMoveColor = null;

    visibleGame.load(
        actualGame.fen()
    );

    if (actualGame.isGameOver()) {
        updateBoard();
        showGameResult();
        return;
    }

    continueAfterMove();
}

function startBlindMove() {
    blindMoveActive = true;
    blindMoveColor = actualGame.turn();

    hideLastMoveAnnotation();

    setStatus(
        'BLIND MOVE — your opponent\'s last move is hidden. Make your move.'
    );

    updateBoard();
}

function continueAfterMove() {
    if (actualGame.isGameOver()) {
        visibleGame.load(
            actualGame.fen()
        );

        updateBoard();

        showGameResult();

        return;
    }

    const nextPlayer =
        actualGame.turn();

    if (shouldNextMoveBeBlind()) {
        if (nextPlayer === HUMAN_COLOR) {
            startBlindMove();
            return;
        }

        if (nextPlayer === ENGINE_COLOR) {
            runEngineTurn(true);
            return;
        }
    }

    visibleGame.load(
        actualGame.fen()
    );

    updateBoard();

    if (actualGame.turn() === ENGINE_COLOR) {
        runEngineTurn(false);
        return;
    }

    setStatus(
        'Your turn.'
    );
}

async function prepareNextBlackBlindPlan() {
    if (!shouldPrepareBlackBlindPlan()) {
        return true;
    }

    if (actualGame.isGameOver()) {
        return false;
    }

    setStatus(
        'Black is preparing its blind move...'
    );

    try {
        await prepareBlackBlindPlan(
            actualGame.fen()
        );

        console.log(
            `Black blind plan prepared for Black ${blackMovesCompleted + 1}.`
        );

        return true;

    } catch (error) {
        console.error(
            'Could not prepare Black blind plan:',
            error
        );

        clearBlackBlindPlan();

        return false;
    }
}

async function runEngineTurn(isBlind = false) {
    if (engineThinking) {
        return;
    }

    engineThinking = true;

    updateBoard();

    try {
        if (isBlind) {
            hideLastMoveAnnotation();

            setStatus(
                'Black is making a hidden move...'
            );

            let result;

            try {
                result = await getBlackBlindMove(
                    actualGame.fen()
                );

            } catch (error) {
                console.warn(
                    'Black blind plan unavailable. Using normal engine move.',
                    error
                );

                const fallbackMove =
                    await getBestMove(
                        actualGame.fen()
                    );

                if (!fallbackMove) {
                    throw new Error(
                        'Stockfish returned no fallback move.'
                    );
                }

                result = {
                    uci: fallbackMove,
                    source: 'emergency-fallback'
                };
            }

            const move =
                uciToMoveObject(result.uci);

            if (!move) {
                throw new Error(
                    `Invalid Black blind move: ${result.uci}`
                );
            }

            const playedMove =
                actualGame.move(move);

            blackMovesCompleted++;

            addMoveAnnotation(
                playedMove,
                true
            );

            console.log(
                `Black blind move source: ${result.source}`
            );

            revealHiddenMoves();

            blindMoveActive = false;
            blindMoveColor = null;

            visibleGame.load(
                actualGame.fen()
            );

            clearBlackBlindPlan();

            if (actualGame.isGameOver()) {
                engineThinking = false;

                updateBoard();

                showGameResult();

                return;
            }

            engineThinking = false;

            continueAfterEngineMove();

            return;
        }

        setStatus(
            `Black is thinking... (${getEngineElo()} Elo)`
        );

        const fen =
            actualGame.fen();

        const bestMove =
            await getBestMove(fen);

        if (!bestMove) {
            throw new Error(
                'Stockfish returned no move.'
            );
        }

        const move =
            uciToMoveObject(bestMove);

        if (!move) {
            throw new Error(
                `Invalid Stockfish move: ${bestMove}`
            );
        }

        const playedMove =
            actualGame.move(move);

        blackMovesCompleted++;

        addMoveAnnotation(
            playedMove,
            false
        );

        if (actualGame.isGameOver()) {
            visibleGame.load(
                actualGame.fen()
            );

            engineThinking = false;

            updateBoard();

            showGameResult();

            return;
        }

        /*
         * IMPORTANT:
         *
         * If White's next move is blind, DO NOT copy actualGame
         * into visibleGame here.
         *
         * actualGame contains Black's move.
         * visibleGame must remain at the position from BEFORE
         * Black's move so the player cannot see it.
         *
         * If White's next move is not blind, we can synchronise
         * the visible board normally.
         */

        if (!shouldNextMoveBeBlind()) {
            visibleGame.load(
                actualGame.fen()
            );
        }

        await prepareNextBlackBlindPlan();

        engineThinking = false;

        continueAfterEngineMove();

    } catch (error) {
        console.error(
            'Engine turn failed:',
            error
        );

        engineThinking = false;

        setStatus(
            'Engine error. Check the browser console.'
        );

        updateBoard();
    }
}

function continueAfterEngineMove() {
    if (actualGame.isGameOver()) {
        visibleGame.load(
            actualGame.fen()
        );

        updateBoard();

        showGameResult();

        return;
    }

    const nextPlayer =
        actualGame.turn();

    if (shouldNextMoveBeBlind()) {
        if (nextPlayer === HUMAN_COLOR) {
            startBlindMove();
            return;
        }

        if (nextPlayer === ENGINE_COLOR) {
            runEngineTurn(true);
            return;
        }
    }

    visibleGame.load(
        actualGame.fen()
    );

    updateBoard();

    setStatus(
        'Your turn.'
    );
}

function showGameResult() {
    if (actualGame.isCheckmate()) {
        const winner =
            actualGame.turn() === 'w'
                ? 'Black'
                : 'White';

        setStatus(
            `Checkmate — ${winner} wins.`
        );

        return;
    }

    if (actualGame.isDraw()) {
        setStatus(
            'Game drawn.'
        );

        return;
    }

    setStatus(
        'Game over.'
    );
}

function updateBoard() {
    const displayGame =
        visibleGame;

    if (blindMoveActive) {
        ground.set({
            fen: displayGame.fen(),
            turnColor: 'white',

            movable: {
                free: false,
                color: 'white',
                dests:
                    getBlindDestinations('w'),
                showDests: false
            }
        });

        return;
    }

    if (engineThinking) {
        ground.set({
            fen: displayGame.fen(),
            turnColor: 'black',

            movable: {
                free: false,
                color: undefined,
                dests: new Map(),
                showDests: false
            }
        });

        return;
    }

    if (actualGame.turn() === HUMAN_COLOR) {
        ground.set({
            fen: displayGame.fen(),
            turnColor: 'white',

            movable: {
                free: false,
                color: 'white',
                dests:
                    getLegalDestinations(actualGame),
                showDests: true
            }
        });

        return;
    }

    ground.set({
        fen: displayGame.fen(),
        turnColor: 'black',

        movable: {
            free: false,
            color: undefined,
            dests: new Map(),
            showDests: false
        }
    });
}

async function initialiseGame() {
    setStatus(
        `Loading Black (${getEngineElo()} Elo)...`
    );

    updateBoard();

    renderMoveAnnotation();

    try {
        await initEngine();

        setStatus(
            'Your turn.'
        );

        updateBoard();

    } catch (error) {
        console.error(
            'Failed to initialise Stockfish:',
            error
        );

        setStatus(
            'Could not load the computer opponent. Check the browser console.'
        );
    }
}

initialiseGame();