-- Executar como admin (postgres) no banco db-senderwhats
-- Este script cria a tabela de sessões Baileys e concede acesso ao usuário restrito

CREATE TABLE IF NOT EXISTS baileys_sessions (
  session_id  VARCHAR PRIMARY KEY,
  creds       TEXT,
  keys        TEXT DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE baileys_sessions TO api_whatsapp;

-- Confirmar
SELECT 'baileys_sessions criada e permissões concedidas a api_whatsapp' AS resultado;
