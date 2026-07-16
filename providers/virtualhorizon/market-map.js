const MARKET_CODES = {
  WINNER: '1X2',
  DOUBLE_CHANCE: 'DC',
  OVER_UNDER: 'OU',
  GOAL_NO_GOAL: 'BTS',
  SCORE: 'CS',
  GOALS: 'TG',
};

function getCanonicalMarketCode(marketName) {
  return MARKET_CODES[marketName] ?? marketName;
}

module.exports = {
  MARKET_CODES,
  getCanonicalMarketCode,
};
