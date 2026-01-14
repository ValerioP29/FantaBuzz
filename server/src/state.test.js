import { describe, expect, it } from 'vitest';
import { makeRoom, playerKey, rebuildView } from './state.js';

describe('playerKey', () => {
  it('builds a normalized key', () => {
    const key = playerKey({ name: 'Mario Rossi', role: 'p', team: 'Inter', fm: '6.5' });
    expect(key).toBe('mario rossi#P#inter#6.5');
  });
});

describe('rebuildView', () => {
  it('filters players by role', () => {
    const room = makeRoom('TEST');
    room.players = [
      { name: 'Alpha', role: 'P' },
      { name: 'Beta', role: 'D' },
    ];
    room.filterRole = 'P';
    rebuildView(room);
    expect(room.viewPlayers).toHaveLength(1);
    expect(room.viewPlayers[0].name).toBe('Alpha');
  });
});
