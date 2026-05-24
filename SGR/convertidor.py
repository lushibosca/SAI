import json
import hashlib
import random
import string
import time

def generar_uid():
    """Genera un ID alfanumérico único imitando el uid() de la PWA."""
    # Convertimos el timestamp a base 36 (similar a Date.now().toString(36))
    timestamp = __import__('numpy').base_repr(int(time.time() * 1000), 36).lower() if __import__('importlib.util').find_spec('numpy') else str(int(time.time() * 1000))
    # Por simplicidad y evitar dependencias externas, usamos un formato aleatorio 100% compatible
    rnd = ''.join(random.choices(string.ascii_lowercase + string.digits, k=12))
    return rnd

def parsear_datos(archivo_entrada, archivo_salida):
    racks = []
    
    try:
        with open(archivo_entrada, 'r', encoding='utf-8') as f:
            lineas = f.readlines()
    except FileNotFoundError:
        print(f"❌ No se encontró el archivo '{archivo_entrada}'.")
        return

    for linea in lineas:
        if not linea.strip():
            continue
            
        # Rellenar columnas faltantes por si la fila está incompleta
        columnas = [col.strip() for col in linea.split('\t')]
        while len(columnas) < 7:
            columnas.append('')
            
        num_raw, pat_raw, uni_raw, mar_raw, edif_raw, piso_raw, dep_raw = columnas[:7]
        
        # Autogenerar ID e identificador hegemónico
        nuevo_id = generar_uid()
        identificador = nuevo_id.upper()
        
        # Limpieza del número de rack
        numero = num_raw
        if numero.lower() == 'no':
            numero = ''
        elif numero.lower().startswith('rack'):
            numero = numero[4:].strip()
            
        # Limpieza de patrimonio y unidades
        patrimonio = pat_raw if pat_raw else 'no'
        
        try:
            unidades = int(uni_raw)
        except ValueError:
            unidades = None
            
        marca = mar_raw  # Mantiene el "?" sin alteraciones
        
        # Lógica de estado
        es_deposito = 'deposito' in dep_raw.lower()
        estado = 'servicio' if (numero and not es_deposito) else 'inventario'
        
        # Formatear el número (rellena con ceros a la izquierda hasta 4 dígitos)
        numero_final = numero.zfill(4) if estado == 'servicio' else ''
        
        racks.append({
            "id": nuevo_id,
            "identificador": identificador,
            "estado": estado,
            "numero": numero_final,
            "patrimonio": patrimonio,
            "marca": marca,
            "modelo": "",
            "unidades": unidades,
            "notas": "",
            "edificio": edif_raw,
            "piso": piso_raw,
            "dependencia": dep_raw
        })
        
    # ═══════════════════════════════════════════════════════
    #  GENERACIÓN DE FIRMA SHA-256 (COMPATIBILIDAD CON JS)
    # ═══════════════════════════════════════════════════════
    # Replicamos la constante 'core' de app.js
    core = {
        "r": [[r["id"], r["numero"], r["marca"], r["modelo"], r["estado"]] for r in racks]
    }
    
    # IMPORTANTE: separators=(',', ':') elimina los espacios por defecto de Python 
    # para que el string sea idéntico al JSON.stringify() de JavaScript.
    str_core = json.dumps(core, separators=(',', ':'))
    firma = hashlib.sha256(str_core.encode('utf-8')).hexdigest()
    
    # Armado del JSON final
    export_data = {
        "racks": racks,
        "_firma": firma
    }
    
    with open(archivo_salida, 'w', encoding='utf-8') as f:
        # Acá sí podemos usar formato legible (indent=2) porque la firma ya se calculó
        json.dump(export_data, f, indent=2, ensure_ascii=False)
        
    print(f"✅ ¡Éxito! Se procesaron y firmaron {len(racks)} racks.")
    print(f"📄 Archivo generado: {archivo_salida}")

if __name__ == '__main__':
    # Lee 'datos.txt' y devuelve el JSON firmado listo para la app
    parsear_datos('datos.txt', 'racks_import.json')