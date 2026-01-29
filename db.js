const { Pool } = require('pg');

// ⚠️ IMPORTANTE: Reemplaza estos valores con tus credenciales de PostgreSQL
const pool = new Pool({
    user: 'postgres',  // Ej: 'postgres'
    host: 'localhost',
    database: 'dice_soccer', // El nombre de tu base de datos
    password: 'postgres',
    port: 5432,
});

// Crea la tabla de usuarios si no existe
pool.query(`
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(100) NOT NULL
    );
`, (err, res) => {
    if (err) {
        console.error('Error al crear la tabla de usuarios:', err);
    } else {
        console.log('Tabla de usuarios verificada/creada exitosamente.');
    }
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool,
};