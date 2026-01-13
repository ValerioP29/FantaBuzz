-- Crea il database (se non lo hai ancora)
-- CREATE DATABASE fantabuzz;

-- Switch al database
-- \c fantabuzz;

-- Tabella delle stanze (room)
CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    phase TEXT NOT NULL DEFAULT 'LOBBY',
    host_token TEXT,
    session_epoch INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Tabella dei team
CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    acquisitions JSONB NOT NULL DEFAULT '[]'::jsonb,
    socket_id TEXT,
    key TEXT,
    session_epoch INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Tabella giocatori disponibili (listone)
CREATE TABLE players (
    id SERIAL PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    team TEXT,
    fm INTEGER,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Tabella storico assegnazioni
CREATE TABLE history (
    id SERIAL PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    player_name TEXT NOT NULL,
    role TEXT NOT NULL,
    price INTEGER NOT NULL,
    player_team TEXT,
    player_fm INTEGER,
    finalized BOOLEAN DEFAULT FALSE,
    finalized_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indici utili
CREATE INDEX idx_teams_room ON teams(room_id);
CREATE INDEX idx_players_room ON players(room_id);
CREATE INDEX idx_history_room ON history(room_id);
CREATE INDEX idx_history_team ON history(team_id);

-- Trigger per aggiornare updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = now();
   RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_rooms_updated BEFORE UPDATE ON rooms
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

CREATE TRIGGER trg_teams_updated BEFORE UPDATE ON teams
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();


/*
Dentro psql ->CREATE DATABASE fantabuzz;
psql -d fantabuzz-f fantabuzz.sql;



*/