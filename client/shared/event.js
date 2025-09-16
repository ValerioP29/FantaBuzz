// shared/events.js (o incollalo in alto ai file se non vuoi un modulo)
export const EVT = {
  HOST_TOGGLE: 'host:toggle',
  HOST_STOP_ROLL: 'host:stopRoll',
  HOST_SKIP: 'host:skip',
  HOST_BACK_N: 'host:backN',
  HOST_PIN: 'host:pinPlayer',
  HOST_UNDO: 'host:undoPurchase',
  HOST_EXIT_CLOSE: 'host:exitAndClose',

  TEAM_REGISTER: 'team:register',
  TEAM_RESUME: 'team:resume',
  TEAM_LEAVE: 'team:leave',
  TEAM_BID_INC: 'team:bid_inc',
  TEAM_BID_FREE: 'team:bid_free',

  AUCTION_STATE: 'state',
  AUCTION_WINNER_ASSIGN: 'winner:autoAssign',
};
