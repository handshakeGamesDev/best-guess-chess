import { Chess } from './node_modules/chess.js/dist/esm/chess.js';

const ENGINE_ELO = 2000;

// Normal engine moves.
const ENGINE_THINK_TIME_MS = 800;

// Prediction searches are a little more involved because we perform
// several searches before Black's blind move.
const BLIND_PREDICTION_THINK_TIME_MS = 700;

let engine = null;
let engineReady = false;
let readyPromise = null;

let pendingMoveResolve = null;
let pendingMoveReject = null;
let pendingMoveTimer = null;


/*
========================================================
ENGINE CREATION / COMMUNICATION
========================================================
*/

function createEngine() {
    const workerUrl =
        `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite-single.js`;

    engine = new Worker(workerUrl);

    engine.onmessage = (event) => {
        const line = String(event.data).trim();

        if (line === 'uciok') {
            engine.postMessage(
                `setoption name UCI_LimitStrength value true`
            );

            engine.postMessage(
                `setoption name UCI_Elo value ${ENGINE_ELO}`
            );

            engine.postMessage(
                `setoption name Threads value 1`
            );

            engine.postMessage(
                `setoption name Hash value 16`
            );

            engine.postMessage('isready');

            return;
        }

        if (line === 'readyok') {
            engineReady = true;
            return;
        }

        if (line.startsWith('bestmove ')) {
            const parts = line.split(/\s+/);
            const bestMove = parts[1];

            if (pendingMoveResolve) {
                clearTimeout(pendingMoveTimer);

                const resolve = pendingMoveResolve;

                pendingMoveResolve = null;
                pendingMoveReject = null;
                pendingMoveTimer = null;

                if (!bestMove || bestMove === '(none)') {
                    resolve(null);
                } else {
                    resolve(bestMove);
                }
            }
        }
    };

    engine.onerror = (error) => {
        console.error('Stockfish engine error:', error);

        if (pendingMoveReject) {
            clearTimeout(pendingMoveTimer);

            const reject = pendingMoveReject;

            pendingMoveResolve = null;
            pendingMoveReject = null;
            pendingMoveTimer = null;

            reject(error);
        }
    };

    engine.postMessage('uci');
}


/*
========================================================
INITIALISATION
========================================================
*/

export function initEngine() {
    if (readyPromise) {
        return readyPromise;
    }

    readyPromise = new Promise((resolve, reject) => {
        try {
            createEngine();

            const checkReady = () => {
                if (engineReady) {
                    resolve();
                } else {
                    setTimeout(checkReady, 50);
                }
            };

            checkReady();

        } catch (error) {
            reject(error);
        }
    });

    return readyPromise;
}


/*
========================================================
BASIC ENGINE SEARCH
========================================================

searchMoves is optional.

If supplied, Stockfish is restricted to choosing from
those moves. This lets us find White's second-best
candidate without using MultiPV.
*/

export async function getBestMove(
    fen,
    {
        thinkTimeMs = ENGINE_THINK_TIME_MS,
        searchMoves = null
    } = {}
) {
    await initEngine();

    return new Promise((resolve, reject) => {
        if (pendingMoveResolve) {
            reject(new Error('Stockfish is already thinking.'));
            return;
        }

        pendingMoveResolve = resolve;
        pendingMoveReject = reject;

        pendingMoveTimer = setTimeout(() => {
            pendingMoveResolve = null;
            pendingMoveReject = null;
            pendingMoveTimer = null;

            reject(new Error('Stockfish timed out.'));
        }, 15000);

        engine.postMessage(`position fen ${fen}`);

        let command = `go movetime ${thinkTimeMs}`;

        if (searchMoves && searchMoves.length > 0) {
            command += ` searchmoves ${searchMoves.join(' ')}`;
        }

        engine.postMessage(command);
    });
}


/*
========================================================
UCI MOVE HELPERS
========================================================
*/

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


function moveObjectToUci(move) {
    let uci = `${move.from}${move.to}`;

    if (move.promotion) {
        uci += move.promotion;
    }

    return uci;
}


/*
========================================================
MOVE LEGALITY
========================================================
*/

function isMoveLegal(fen, uci) {
    if (!uci) {
        return false;
    }

    try {
        const game = new Chess(fen);

        const move = uciToMoveObject(uci);

        if (!move) {
            return false;
        }

        game.move(move);

        return true;

    } catch {
        return false;
    }
}


/*
========================================================
APPLY A MOVE TO A TEMPORARY POSITION
========================================================
*/

function getPositionAfterMove(fen, uci) {
    const game = new Chess(fen);

    const move = uciToMoveObject(uci);

    if (!move) {
        throw new Error(`Invalid UCI move: ${uci}`);
    }

    game.move(move);

    return game.fen();
}


/*
========================================================
GET ALL LEGAL MOVES AS UCI
========================================================
*/

function getAllLegalUciMoves(fen) {
    const game = new Chess(fen);

    const moves = game.moves({
        verbose: true
    });

    return moves.map(moveObjectToUci);
}


/*
========================================================
BLACK BLIND PREDICTION PLAN
========================================================

This is the heart of the blind-bot system.

At the end of Black 9 we calculate:

    Prediction 1:
        White's most likely move
        Black's best response

    Prediction 2:
        White's second candidate move
        Black's best response

The actual White move on move 10 does NOT select
which response gets played.

Instead:

    Response 1 is committed first.
    If Response 1 becomes illegal, try Response 2.
    If Response 2 is also illegal, calculate a
    completely fresh engine move.

This deliberately allows White to play an unexpected
move that makes a still-legal predicted response
strategically bad.
========================================================
*/

let blackBlindPlan = null;


/*
Create the plan immediately after Black has played
the preceding normal move.
*/

export async function prepareBlackBlindPlan(fen) {
    console.log('Preparing Black blind plan...');

    /*
    ----------------------------------------------------
    PREDICTION 1
    ----------------------------------------------------
    */

    const predictedWhiteMove1 = await getBestMove(
        fen,
        {
            thinkTimeMs: BLIND_PREDICTION_THINK_TIME_MS
        }
    );

    if (!predictedWhiteMove1) {
        throw new Error(
            'Stockfish could not calculate White prediction 1.'
        );
    }

    const positionAfterWhite1 = getPositionAfterMove(
        fen,
        predictedWhiteMove1
    );

    const blackResponse1 = await getBestMove(
        positionAfterWhite1,
        {
            thinkTimeMs: BLIND_PREDICTION_THINK_TIME_MS
        }
    );

    if (!blackResponse1) {
        throw new Error(
            'Stockfish could not calculate Black response 1.'
        );
    }


    /*
    ----------------------------------------------------
    PREDICTION 2
    ----------------------------------------------------

    Get every legal White move except prediction 1,
    then ask Stockfish for the best move from that
    remaining set.

    This avoids MultiPV.
    */

    const allWhiteMoves = getAllLegalUciMoves(fen);

    const remainingWhiteMoves = allWhiteMoves.filter(
        move => move !== predictedWhiteMove1
    );

    let predictedWhiteMove2 = null;
    let blackResponse2 = null;

    if (remainingWhiteMoves.length > 0) {

        predictedWhiteMove2 = await getBestMove(
            fen,
            {
                thinkTimeMs: BLIND_PREDICTION_THINK_TIME_MS,
                searchMoves: remainingWhiteMoves
            }
        );

        if (predictedWhiteMove2) {

            const positionAfterWhite2 = getPositionAfterMove(
                fen,
                predictedWhiteMove2
            );

            blackResponse2 = await getBestMove(
                positionAfterWhite2,
                {
                    thinkTimeMs: BLIND_PREDICTION_THINK_TIME_MS
                }
            );
        }
    }


    /*
    ----------------------------------------------------
    STORE THE PLAN
    ----------------------------------------------------
    */

    blackBlindPlan = {
        sourceFen: fen,

        prediction1: {
            whiteMove: predictedWhiteMove1,
            blackResponse: blackResponse1
        },

        prediction2: {
            whiteMove: predictedWhiteMove2,
            blackResponse: blackResponse2
        }
    };


    console.log(
        'Black blind plan:',
        blackBlindPlan
    );

    return blackBlindPlan;
}


/*
========================================================
GET THE COMMITTED BLIND MOVE
========================================================

Called AFTER White has actually played move 10.

Notice that we deliberately DO NOT compare White's
actual move with the predicted White moves.

The predictions are simply the basis on which Black
pre-calculated its responses.

Response 1 gets first priority.

If it is illegal in the real position, Response 2
gets a chance.

Only if both are illegal do we calculate a fresh move.
========================================================
*/

export async function getBlackBlindMove(actualFen) {

    if (!blackBlindPlan) {
        throw new Error(
            'No Black blind plan is available.'
        );
    }


    /*
    ----------------------------------------------------
    TRY RESPONSE 1
    ----------------------------------------------------
    */

    const response1 =
        blackBlindPlan.prediction1.blackResponse;

    if (response1 && isMoveLegal(actualFen, response1)) {

        console.log(
            'Black blind move: using prediction 1 response',
            response1
        );

        return {
            uci: response1,
            source: 'prediction1'
        };
    }


    /*
    ----------------------------------------------------
    TRY RESPONSE 2
    ----------------------------------------------------
    */

    const response2 =
        blackBlindPlan.prediction2.blackResponse;

    if (response2 && isMoveLegal(actualFen, response2)) {

        console.log(
            'Black blind move: prediction 1 illegal; using prediction 2',
            response2
        );

        return {
            uci: response2,
            source: 'prediction2'
        };
    }


    /*
    ----------------------------------------------------
    BOTH PREDICTIONS FAILED
    ----------------------------------------------------

    Now the bot is forced to abandon the blind plan.

    We calculate a completely fresh move from the
    actual position.
    */

    console.log(
        'Black blind predictions both illegal. Calculating fresh move.'
    );

    const fallbackMove = await getBestMove(
        actualFen,
        {
            thinkTimeMs: ENGINE_THINK_TIME_MS
        }
    );

    if (!fallbackMove) {
        throw new Error(
            'Stockfish could not find a fallback move.'
        );
    }

    return {
        uci: fallbackMove,
        source: 'fallback'
    };
}


/*
========================================================
CLEAR BLIND PLAN
========================================================
*/

export function clearBlackBlindPlan() {
    blackBlindPlan = null;
}


/*
========================================================
INFO
========================================================
*/

export function getEngineElo() {
    return ENGINE_ELO;
}