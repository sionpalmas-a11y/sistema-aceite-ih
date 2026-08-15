require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.get('/termo/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'termo.html'));
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render') ? { rejectUnauthorized: false } : false
});

async function inicializarBanco() {
    if (!process.env.DATABASE_URL) {
        console.error('ERRO: DATABASE_URL não foi configurada nas variáveis do Render.');
        return;
    }

    try {
        // Criando a tabela caso não exista
        await pool.query(`
            CREATE TABLE IF NOT EXISTS aceites_ih (
                id SERIAL PRIMARY KEY,
                paciente_nome VARCHAR(255) NOT NULL,
                paciente_cpf VARCHAR(20) NOT NULL,
                paciente_telefone VARCHAR(20) NOT NULL,
                protocolo_ih VARCHAR(100) NOT NULL,
                token VARCHAR(64) UNIQUE NOT NULL,
                status VARCHAR(20) DEFAULT 'PENDENTE',
                data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                data_aceite TIMESTAMP,
                ip_paciente VARCHAR(45),
                user_agent TEXT,
                termo_versao TEXT,
                retirante_nome VARCHAR(255),
                retirante_cpf VARCHAR(20),
                retirante_telefone VARCHAR(20)
            );
        `);

        // Garante que as colunas adicionais existam
        await pool.query(`ALTER TABLE aceites_ih ADD COLUMN IF NOT EXISTS retirante_nome VARCHAR(255);`);
        await pool.query(`ALTER TABLE aceites_ih ADD COLUMN IF NOT EXISTS retirante_cpf VARCHAR(20);`);
        await pool.query(`ALTER TABLE aceites_ih ADD COLUMN IF NOT EXISTS retirante_telefone VARCHAR(20);`);

        console.log('Tabela aceites_ih verificada/atualizada com sucesso no banco!');
    } catch (err) {
        console.error('Erro ao criar/atualizar tabela no banco de dados:', err);
    }
}

app.get('/api/solicitacoes', async (req, res) => {
    try {
        const query = `
            SELECT 
                id, 
                paciente_nome, 
                paciente_cpf, 
                paciente_telefone, 
                protocolo_ih, 
                token, 
                status, 
                COALESCE(TO_CHAR(data_criacao AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'), '') as data_criacao, 
                COALESCE(TO_CHAR(data_aceite AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'), '') as data_aceite 
            FROM aceites_ih 
            WHERE status != 'CANCELADO'
            ORDER BY id DESC;
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error('Erro em GET /api/solicitacoes:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar lista.' });
    }
});

app.post('/api/solicitacoes', async (req, res) => {
    try {
        const { paciente_nome, paciente_cpf, paciente_telefone, protocolo_ih } = req.body;
        const token = crypto.randomBytes(16).toString('hex');

        const query = `
            INSERT INTO aceites_ih (paciente_nome, paciente_cpf, paciente_telefone, protocolo_ih, token)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *;
        `;
        const values = [paciente_nome, paciente_cpf, paciente_telefone, protocolo_ih, token];
        const result = await pool.query(query, values);

        res.json({ success: true, registro: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Erro ao salvar solicitação.' });
    }
});

app.get('/api/termo/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const query = 'SELECT paciente_nome, paciente_cpf, protocolo_ih, status, data_aceite FROM aceites_ih WHERE token = $1';
        const result = await pool.query(query, [token]);

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Termo ou autorização não encontrada.' });
        }

        res.json({ success: true, dados: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Erro ao carregar termo.' });
    }
});

app.post('/api/aceitar-termo', async (req, res) => {
    try {
        const { token, termo_texto, retirante_nome, retirante_cpf, retirante_telefone } = req.body;
        const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const ip = rawIp ? rawIp.split(',')[0].trim() : req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'];

        const query = `
            UPDATE aceites_ih
            SET status = 'ACEITO',
                data_aceite = CURRENT_TIMESTAMP,
                ip_paciente = $1,
                user_agent = $2,
                termo_versao = $3,
                retirante_nome = $4,
                retirante_cpf = $5,
                retirante_telefone = $6
            WHERE token = $7 AND status = 'PENDENTE'
            RETURNING *;
        `;
        const result = await pool.query(query, [ip, userAgent, termo_texto, retirante_nome, retirante_cpf, retirante_telefone, token]);

        if (result.rowCount === 0) {
            return res.status(400).json({ success: false, error: 'Este termo já foi aceito anteriormente ou o link é inválido.' });
        }

        res.json({ success: true, message: 'Aceite registrado com sucesso!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Erro ao registrar aceite.' });
    }
});

app.get('/api/solicitacoes', async (req, res) => {
    try {
        const query = `
            SELECT 
                id, 
                paciente_nome, 
                paciente_cpf, 
                paciente_telefone, 
                protocolo_ih, 
                token, 
                status, 
                TO_CHAR(data_criacao AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as data_criacao, 
                TO_CHAR(data_aceite AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as data_aceite 
            FROM aceites_ih 
            ORDER BY id DESC;
        `;
        const result = await pool.query(query, [token]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Erro ao buscar lista.' });
    }
});

app.get('/api/comprovante/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const query = `
            SELECT 
                paciente_nome, 
                paciente_cpf, 
                paciente_telefone, 
                protocolo_ih, 
                status, 
                TO_CHAR(data_criacao AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS') as data_criacao,
                TO_CHAR(data_aceite AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS') as data_aceite,
                ip_paciente,
                user_agent,
                termo_versao,
                token,
                retirante_nome,
                retirante_cpf,
                retirante_telefone
            FROM aceites_ih 
            WHERE token = $1;
        `;
        
        // Passagem do array de parâmetros [token] corrigida
        const result = await pool.query(query, [token]);

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Comprovante não encontrado.' });
        }

        res.json({ success: true, dados: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Erro ao buscar comprovante.' });
    }
});
app.delete('/api/solicitacoes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const query = "UPDATE aceites_ih SET status = 'CANCELADO' WHERE id = $1 RETURNING *;";
        const result = await pool.query(query, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Registro não encontrado.' });
        }

        res.json({ success: true, message: 'Registro excluído com sucesso!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Erro ao excluir registro.' });
    }
});

app.get('/api/verificar-aceites-pendentes', async (req, res) => {
    try {
        const querySelect = `
            SELECT 
                protocolo_ih, 
                status, 
                TO_CHAR(data_aceite AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS') as data_aceite,
                ip_paciente AS ip_aceite, 
                user_agent, 
                token,
                paciente_nome,
                paciente_cpf,
                paciente_telefone,
                retirante_nome,
                retirante_cpf,
                retirante_telefone
            FROM aceites_ih 
            WHERE status IN ('ACEITO', 'SINCRONIZADO')
            ORDER BY id DESC
            LIMIT 50;
        `;
        const result = await pool.query(querySelect);

        const aceitesPendentes = result.rows.filter(r => r.status === 'ACEITO');
        if (aceitesPendentes.length > 0) {
            const tokens = aceitesPendentes.map(r => r.token);
            await pool.query(`
                UPDATE aceites_ih 
                SET status = 'SINCRONIZADO' 
                WHERE token = ANY($1::text[])
            `, [tokens]);
        }

        res.json(result.rows);
    } catch (err) {
        console.error('Erro na verificação de aceites pendentes:', err);
        res.status(500).json({ success: false, error: 'Erro ao verificar aceites.' });
    }
});

app.listen(PORT, async () => {
    await inicializarBanco();
    console.log(`Servidor de Aceite IH rodando na porta: ${PORT}`);
});
