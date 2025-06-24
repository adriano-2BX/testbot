/*
 * =================================================================
 * API Backend Simplificada para o TestBot Manager
 * =================================================================
 * Servidor completo em um único ficheiro Node.js/Express para facilitar o uso.
 * Conecta-se diretamente à base de dados MySQL e fornece todos os endpoints
 * necessários para a aplicação frontend.
 *
 * --- COMO EXECUTAR ---
 * 1. Guarde este código num ficheiro chamado `server.js`.
 * 2. Na linha de comandos, na mesma pasta, instale as dependências:
 * npm install express mysql2 cors bcryptjs jsonwebtoken
 * 3. Execute o servidor:
 * node server.js
 * 4. O servidor estará a correr em http://localhost:3001
*/

// --- 1. IMPORTAÇÕES E CONFIGURAÇÃO INICIAL ---
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 3001;

// --- Middlewares ---
app.use(cors());      // Permite que o frontend (em outra porta/domínio) aceda à API
app.use(express.json()); // Permite ao servidor entender JSON nas requisições

// --- 2. CONFIGURAÇÃO DA BASE DE DADOS E TOKEN ---
// Conexão ao banco de dados (substitua se necessário)
const dbConfig = "mysql://mysql:bc86348b3cfea8e64566@server.2bx.com.br:3306/testbot";
const pool = mysql.createPool(dbConfig);

// Chave secreta para os tokens JWT
const JWT_SECRET = "SEGREDO_MUITO_SECRETO_E_COMPLEXO"; // Em produção, isto NUNCA deve estar no código.

// --- 3. MIDDLEWARE DE AUTENTICAÇÃO ---
// Esta função verifica se um pedido tem um token válido antes de prosseguir.
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Acesso negado. Token não fornecido.' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // Adiciona os dados do utilizador (id, role) ao pedido
        next();
    } catch (error) {
        res.status(400).json({ message: 'Token inválido.' });
    }
};

// --- 4. ROTAS DA API ---

// Rota de teste para verificar se o servidor está online
app.get('/', (req, res) => {
    res.json({ message: 'API do TestBot Manager está a funcionar!' });
});

// -- ROTAS DE AUTENTICAÇÃO --
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (rows.length === 0) {
            return res.status(401).json({ message: "Credenciais inválidas." });
        }
        const user = rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ message: "Credenciais inválidas." });
        }
        const tokenPayload = { id: user.id, name: user.name, role: user.role };
        const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '8h' });
        res.json({ message: "Login bem-sucedido!", token, user: tokenPayload });
    } catch (error) {
        res.status(500).json({ message: "Erro no servidor ao tentar fazer login.", error: error.message });
    }
});

// -- ROTA PARA CARREGAR TODOS OS DADOS INICIAIS --
app.get('/api/data/all', authMiddleware, async (req, res) => {
    try {
        // Executa todas as consultas em paralelo para maior eficiência
        const [
            clients,
            projects,
            users,
            testCases,
            reports,
            customTestTemplates,
            testTemplates
        ] = await Promise.all([
            pool.query('SELECT * FROM clients'),
            pool.query('SELECT * FROM projects'),
            pool.query('SELECT id, name, email, role FROM users'),
            pool.query('SELECT * FROM test_cases'),
            pool.query('SELECT * FROM reports'),
            pool.query('SELECT * FROM test_templates WHERE is_custom = TRUE'),
            pool.query('SELECT * FROM test_templates WHERE is_custom = FALSE')
        ]);

        res.json({
            clients: clients[0],
            projects: projects[0],
            users: users[0],
            testCases: testCases[0].map(tc => ({...tc, custom_fields: JSON.parse(tc.custom_fields || '[]'), paused_state: JSON.parse(tc.paused_state || '{}')})),
            reports: reports[0].map(r => ({...r, results: JSON.parse(r.results || '{}')})),
            customTestTemplates: customTestTemplates[0].map(t => ({...t, form_fields: JSON.parse(t.form_fields || '[]')})),
            presetTests: testTemplates[0].map(t => ({...t, form_fields: JSON.parse(t.form_fields || '[]')})),
        });
    } catch (error) {
        res.status(500).json({ message: "Erro ao buscar dados iniciais.", error: error.message });
    }
});


// -- ROTAS PARA GERIR TESTES --
app.post('/api/test-cases', authMiddleware, async (req, res) => {
    const { projectId, typeId, assignedTo, customFields } = req.body;
    const newId = `TEST-${Date.now()}`;
    try {
        await pool.execute(
            'INSERT INTO test_cases (id, project_id, template_id, assigned_to_id, custom_fields) VALUES (?, ?, ?, ?, ?)',
            [newId, projectId, typeId, assignedTo, JSON.stringify(customFields)]
        );
        res.status(201).json({ message: 'Caso de teste criado com sucesso!', id: newId });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao criar caso de teste.', error: error.message });
    }
});

app.put('/api/test-cases/:id/pause', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { pausedState } = req.body;
    try {
        await pool.execute(
            'UPDATE test_cases SET status = ?, paused_state = ? WHERE id = ?',
            ['paused', JSON.stringify(pausedState), id]
        );
        res.json({ message: 'Teste pausado com sucesso.' });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao pausar teste.', error: error.message });
    }
});

app.put('/api/test-cases/:id/resume', authMiddleware, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.execute(
            "UPDATE test_cases SET status = 'pending' WHERE id = ?",
            [id]
        );
        res.json({ message: 'Teste retomado.' });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao retomar teste.', error: error.message });
    }
});

// -- ROTA PARA CRIAR RELATÓRIOS (quando um teste é concluído) --
app.post('/api/reports', authMiddleware, async (req, res) => {
    const { testCaseId, resultData } = req.body;
    const testerId = req.user.id;
    const newReportId = `REP-${Date.now()}`;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // 1. Obter dados do projeto
        const [testCases] = await connection.execute('SELECT project_id FROM test_cases WHERE id = ?', [testCaseId]);
        if (testCases.length === 0) throw new Error("Caso de teste não encontrado.");
        const projectId = testCases[0].project_id;
        
        const [projects] = await connection.execute('SELECT client_id FROM projects WHERE id = ?', [projectId]);
        if (projects.length === 0) throw new Error("Projeto não encontrado.");
        const clientId = projects[0].client_id;
        
        // 2. Inserir o relatório
        await connection.execute(
            'INSERT INTO reports (id, test_case_id, tester_id, execution_date, results) VALUES (?, ?, ?, ?, ?)',
            [newReportId, testCaseId, testerId, new Date(), JSON.stringify(resultData)]
        );
        
        // 3. Atualizar o status do caso de teste para 'completed'
        await connection.execute(
            "UPDATE test_cases SET status = 'completed', paused_state = NULL WHERE id = ?",
            [testCaseId]
        );

        await connection.commit();
        res.status(201).json({ message: 'Relatório criado com sucesso!', id: newReportId });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ message: 'Erro ao criar relatório.', error: error.message });
    } finally {
        connection.release();
    }
});


// -- ROTAS PARA CRIAR MODELOS DE TESTE PERSONALIZADOS --
app.post('/api/templates', authMiddleware, async (req, res) => {
    const { name, description, formFields } = req.body;
    const newId = `CUSTOM-${Date.now()}`;
    try {
        await pool.execute(
            "INSERT INTO test_templates (id, name, description, form_fields, is_custom) VALUES (?, ?, ?, ?, TRUE)",
            [newId, name, description, JSON.stringify(formFields)]
        );
        res.status(201).json({ message: 'Modelo criado com sucesso!', id: newId });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao criar modelo.', error: error.message });
    }
});

// --- 5. INICIAR O SERVIDOR ---
app.listen(PORT, async () => {
    try {
        // Garante que a conexão com o banco é testada antes de o servidor começar a aceitar pedidos.
        await pool.query('SELECT 1');
        console.log('✅ Conexão com o MySQL estabelecida com sucesso!');
        console.log(`🚀 Servidor a correr na porta ${PORT}`);
    } catch (error) {
        console.error('❌ Não foi possível conectar à base de dados. O servidor não foi iniciado.', error.message);
        process.exit(1);
    }
});

