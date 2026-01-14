import { describe, expect, it } from 'vitest';
import { parseCSV, mapPlayers } from './csv.js';

describe('parseCSV', () => {
  it('parses quoted values and commas', () => {
    const text = 'Nome,R.,Sq.,FM\n"Rossi, Mario",P,Inter,6.5';
    const { header, items } = parseCSV(text);
    expect(header).toEqual(['Nome', 'R.', 'Sq.', 'FM']);
    expect(items[0]['Nome']).toBe('Rossi, Mario');
  });

  it('handles semicolon delimiter', () => {
    const text = 'Nome;R.;Sq.;FM\nLuca;D;Milan;6,0';
    const { header, items } = parseCSV(text);
    expect(header).toEqual(['Nome', 'R.', 'Sq.', 'FM']);
    expect(items[0]['Nome']).toBe('Luca');
  });
});

describe('mapPlayers', () => {
  it('deduplicates by full key', () => {
    const items = [
      { Nome: 'Bianchi', 'R.': 'C', 'Sq.': 'Roma', FM: '6.5' },
      { Nome: 'Bianchi', 'R.': 'C', 'Sq.': 'Lazio', FM: '6.5' },
    ];
    const players = mapPlayers(items, { name: 'Nome', role: 'R.', team: 'Sq.', fm: 'FM' });
    expect(players).toHaveLength(2);
  });
});
