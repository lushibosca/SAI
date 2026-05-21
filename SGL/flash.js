(function () { 
    try { 
        // Leemos la clave exacta que usa app.js
        if (localStorage.getItem('sgl_dark') === 'dark') { 
            // Aplicamos al <html> porque el <body> aún no cargó
            document.documentElement.classList.add('dark-mode'); 
        } 
    } catch (e) { } 
}());
// Parche anti parpadeo blanco en modo oscuro
