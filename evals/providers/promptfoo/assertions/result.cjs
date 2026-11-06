// Native Promptfoo scoring is an adapter concern. Shared checks return only
// pass/reason/evidence and do not know GradingResult or componentResults.
function gradingResult({ checks, ...result }) {
  return { ...result, score: result.pass ? 1 : 0,
    ...(checks ? { componentResults: checks.map(gradingResult) } : {}) };
}

module.exports = { gradingResult };
