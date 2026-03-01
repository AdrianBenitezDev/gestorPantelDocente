function getConfiguracionHorarios(id=80756) {

  var datosPorId = obtenerDatos_Usuarios_Registrados(id);
  var urlPofaUser = datosPorId[2];

  Logger.log(urlPofaUser)

  var spreadsheet = SpreadsheetApp.openByUrl(urlPofaUser);
  var sheet = spreadsheet.getSheetByName("CONF");

  if (!sheet) {
    Logger.log("❌ Error: La hoja 'POFA' no existe.");
    return ["sin sheet"];
  }

  try {
    // Detectar la última fila con datos (en cualquier columna de A a Y)
   var lastRow = sheet.getLastRow();

    if (lastRow < 3) {
      Logger.log("❌ No hay suficientes filas con datos desde A3.");
      return ["sin datos"];
    }

    // Tomar desde la fila 3 hasta la última detectada, columnas A a Y (columnas 1 a 25)
    var dataRange = sheet.getRange(3, 1, lastRow, 4);
    var values = dataRange.getValues();

    Logger.log(JSON.stringify(values))
    return JSON.stringify(values); // devuelve un string

  } catch (e) {
    Logger.log("❌ Error al obtener los datos dinámicos: " + e.message);
    return [e.message];
  }
}
