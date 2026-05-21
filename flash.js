(function () { 
    'use strict';
    try { 
        if (localStorage.getItem('po_dark') === '1') { 
            document.documentElement.classList.add('dark-mode'); 
        } 
    } catch (e) { } 
}());