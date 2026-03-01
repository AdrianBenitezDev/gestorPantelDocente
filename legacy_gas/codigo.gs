function doGet(e) {
  const page = (e && e.parameter.page) ? e.parameter.page : 'index';

  // Títulos personalizados por página
  const titulos = {
    'index': 'Horarios_prueba',
    'registrarse': 'registrarse',
    'creadorPac': 'Creador de Pac',
    'validarCode': 'autenticar correo',
  };
  const titulo = titulos[page] || 'Horarios_prueba';

  // Crear plantilla y pasar parámetros
  const template = HtmlService.createTemplateFromFile(page);

  // Si hay código de verificación en la URL, pasarlo
  template.verificar = e.parameter.verificar || '';

  return template.evaluate().setTitle(titulo);
}



// Variable global para la celda donde se almacenará el número de versión
const VERSION_CELL = 'B1';
const URL_EXCEL_ESCUELAS_DATOS_USUARIOS='https://docs.google.com/spreadsheets/d/11ewssae5EgqDBvaPhg2J4azV-qIIfMZB5OyWEjC4f48/edit?gid=0#gid=0';



//devolvemos la lista para obtener los botones
function colbtn(id=80756){
    var datosPorId = obtenerDatos_Usuarios_Registrados(id);
  var urlPofaUser = datosPorId[2];
  //Logger.log("URL: " + urlPofaUser);

  var spreadsheet = SpreadsheetApp.openByUrl(urlPofaUser);
  var sheet = spreadsheet.getSheetByName("CUPOF");


    var rangeTurno = sheet.getRange("E3:E");
    var valuesTurno = rangeTurno.getValues();

    var rangeCurso = sheet.getRange("B3:B");
    var valuesCurso = rangeCurso.getValues();

    var arrayDato=[]
 
    //console.log(valuesCurso);
    valuesCurso.forEach((curso,index)=>{
      if(curso[0]!==''){
        arrayDato.push([curso[0],valuesTurno[index][0]])
      }
      
    })


    console.log(arrayDato)

  
const vistos = new Set();
const newArray = arrayDato.filter(fila => {
  if(fila[1]!=='C'||fila[1]==''){

  const turno = fila[0];
  if (vistos.has(turno)) return false;
  vistos.add(turno);
  return true;
  }else{

    return false
  }
});

console.log(newArray);

  // Convertir a JSON (opcional)
  var res = JSON.stringify(newArray);

//    Logger.log(res)

  return res;
    
}

//obtenemos los datos de los usuarios registrados

function obtenerUsuariosRegistrados(){

  var sheet=SpreadsheetApp.openByUrl(URL_EXCEL_ESCUELAS_DATOS_USUARIOS);
  const data = sheet.getDataRange().getValues(); // Esto obtiene toda la tabla
  Logger.log(data);


}

function obtenerMailUsuario() {
  return Session.getActiveUser().getEmail();
}


function obtenerDatos_Usuarios_Registrados(id) {
  //usamos la url directamente
  var sheet = SpreadsheetApp.openByUrl(URL_EXCEL_ESCUELAS_DATOS_USUARIOS);
  const data = sheet.getDataRange().getValues();

  for (var i = 0; i < data.length; i++) {
    if (data[i][0] == id) {
      Logger.log(data[i]); // Mostrar la fila
      return data[i];      // ✅ Esto ahora sí devuelve la fila completa
    }
  }

  return null; // Por si no encuentra el ID
}


function actualizarEmailsDocentes(entrada) {

let indiceHojas=[1,2];

  // Crear un objeto de búsqueda rápido para los objetos
  var cuilsYMail = {};
  mailPersonal.forEach(function(objeto) {
    cuilsYMail[objeto.cuil] = objeto.mail;
  });

indiceHojas.forEach((elemento)=>{
 // Obtén la hoja activa (la primera hoja)
  var hoja = SpreadsheetApp.getActiveSpreadsheet().getSheets()[elemento];



  // Obtén todos los datos de la hoja
  var datos = hoja.getDataRange().getValues();
  
  // Simulamos un objeto con los datos (puedes usar datos reales, ejemplo de estructura)

  
  // Recorre cada fila de datos (comienza en 1 para saltarse el encabezado si lo tienes)
  for (var i = 1; i < datos.length; i++) {


let columnaCuilTitular=0;
let columnaCuilSuplente=0;
let columnaDataPushS=0;
let columnaDataPushT=0;

if(elemento==0){

    columnaCuilSuplente=7;
    columnaCuilTitular=14;
    columnaDataPushS=24;
    columnaDataPushT=21;

}else if(elemento==1){


   columnaCuilSuplente=5;
    columnaCuilTitular=3;
    columnaDataPushS=19;
    columnaDataPushT=16;

}else if(elemento==2){



   columnaCuilSuplente=5;
    columnaCuilTitular=3;
    columnaDataPushS=19;
    columnaDataPushT=16;

}

if(elemento==0||1||2){

    var cuilSuplente = datos[i][columnaCuilSuplente]; // Columna H (índice 7)
    var cuilTitular = datos[i][columnaCuilTitular]; // Columna O (índice 14)
    
    // Verifica si el CUIL está en el objeto y actualiza las celdas correspondientes
    if (cuilsYMail[cuilSuplente]) {
      // Si el CUIL coincide con el de la key, actualiza la columna X (índice 23) con el mail
      hoja.getRange(i + 1, columnaDataPushS).setValue(cuilsYMail[cuilSuplente]); // Columna X (índice 23)
      
  
    }
    if(cuilsYMail[cuilTitular]){
      hoja.getRange(i + 1, columnaDataPushT).setValue(cuilsYMail[cuilTitular]); // Columna X (índice 23)
     

    }
}

  }








})

  
}














function comprobarCodigoUseiarioMaster(codigo){
  if(codigo=="tristan"){
    return true
  }else{
    return false
  }
}

function irCelda() {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var range = sheet.getRange('A5');
    sheet.setActiveRange(range);
}

function getDataCupof(id=80756) {
  var datosPorId = obtenerDatos_Usuarios_Registrados(id);
  var urlPofaUser = datosPorId[2];

  var spreadsheet = SpreadsheetApp.openByUrl(urlPofaUser);
  var sheet = spreadsheet.getSheetByName("CUPOF");

  if (!sheet) {
    Logger.log("❌ Error: La hoja 'POFA' no existe.");
    return ["sin sheet"];
  }

  try {
    // Detectar la última fila con datos (en cualquier columna de A a Y)
    var lastRow = sheet.getRange("A:J").getValues().reduceRight((acc, row, index) => {
      return (acc === 0 && row.join("") !== "") ? index + 1 : acc;
    }, 0);

    if (lastRow < 3) {
      Logger.log("❌ No hay suficientes filas con datos desde A3.");
      return ["sin datos"];
    }

    // Tomar desde la fila 3 hasta la última detectada, columnas A a J (columnas 1 a 10)
    var dataRange = sheet.getRange(3, 1, lastRow - 2, 10);
    var values = dataRange.getValues();

    Logger.log(JSON.stringify(values))
    return JSON.stringify(values); // devuelve un string

  } catch (e) {
    Logger.log("❌ Error al obtener los datos dinámicos: " + e.message);
    return [e.message];
  }
}

function getDataDocentes(id=80756) {
  var datosPorId = obtenerDatos_Usuarios_Registrados(id);
  var urlPofaUser = datosPorId[2];

  var spreadsheet = SpreadsheetApp.openByUrl(urlPofaUser);
  var sheet = spreadsheet.getSheetByName("DOCENTES");

  if (!sheet) {
    Logger.log("❌ Error: La hoja 'POFA' no existe.");
    return ["sin sheet"];
  }

  try {
    // Detectar la última fila con datos (en cualquier columna de A a E)
    var lastRow = sheet.getRange("A:E").getValues().reduceRight((acc, row, index) => {
      return (acc === 0 && row.join("") !== "") ? index + 1 : acc;
    }, 0);

    if (lastRow < 3) {
      Logger.log("❌ No hay suficientes filas con datos desde A3.");
      return ["sin datos"];
    }

    // Tomar desde la fila 3 hasta la última detectada, columnas A a E (columnas 1 a 5)
    var dataRange = sheet.getRange(3, 1, lastRow - 2, 5);
    var values = dataRange.getValues();

    Logger.log(JSON.stringify(values))
    return JSON.stringify(values); // devuelve un string

  } catch (e) {
    Logger.log("❌ Error al obtener los datos dinámicos: " + e.message);
    return [e.message];
  }
}


function getDataCuDc(id=80756) {
  var datosPorId = obtenerDatos_Usuarios_Registrados(id);
  var urlPofaUser = datosPorId[2];

  var spreadsheet = SpreadsheetApp.openByUrl(urlPofaUser);
  var sheet = spreadsheet.getSheetByName("CUDC");

  if (!sheet) {
    Logger.log("❌ Error: La hoja 'POFA' no existe.");
    return ["sin sheet"];
  }

  try {
    // Detectar la última fila con datos (en cualquier columna de A a E)
    var lastRow = sheet.getRange("A:E").getValues().reduceRight((acc, row, index) => {
      return (acc === 0 && row.join("") !== "") ? index + 1 : acc;
    }, 0);

    if (lastRow < 3) {
      Logger.log("❌ No hay suficientes filas con datos desde A3.");
      return ["sin datos"];
    }

    // Tomar desde la fila 3 hasta la última detectada, columnas A a E (columnas 1 a 5)
    var dataRange = sheet.getRange(3, 1, lastRow - 2, 5);
    var values = dataRange.getValues();

    Logger.log(JSON.stringify(values))
    return JSON.stringify(values); // devuelve un string

  } catch (e) {
    Logger.log("❌ Error al obtener los datos dinámicos: " + e.message);
    return [e.message];
  }
}





function login(usuario,password){

  //usamos la url directamente
  var sheet = SpreadsheetApp.openByUrl(URL_EXCEL_ESCUELAS_DATOS_USUARIOS);
  const data = sheet.getDataRange().getValues();
  
  var coincidencias=[];

  for (var i = 0; i < data.length; i++) {
    if (data[i][4] == usuario && data[i][5] == password) {
      //Logger.log(data[i]); // Mostrar la fila
      coincidencias=data[i];      // ✅ Esto ahora sí devuelve la fila completa
      break;
    }
  }

  
    if(coincidencias.length>0){
      return [coincidencias[0],coincidencias[1],
      coincidencias[2],
      coincidencias[3],
      coincidencias[4]];
    } else{
      return coincidencias
    }
}


function loginConMail(){

//revisamo si el mail ya se encuentra en nuestra base de datos de pago
 var mailActivo=Session.getActiveUser().getEmail();

  //usamos la url directamente
  var sheet = SpreadsheetApp.openByUrl(URL_EXCEL_ESCUELAS_DATOS_USUARIOS);
  const data = sheet.getDataRange().getValues();
  
  var coincidencias=[];

  for (var i = 0; i < data.length; i++) {
    if (data[i][1] == mailActivo) {
      //Logger.log(data[i]); // Mostrar la fila
      coincidencias=data[i];      // ✅ Esto ahora sí devuelve la fila completa
      break;
    }
  }

  
    return [coincidencias[0],coincidencias[1],
    coincidencias[2],
    coincidencias[3],
    coincidencias[4]];
  
}

function getDataHorarios(id=80756,rango='A3:D20') {
   var datosPorId = obtenerDatos_Usuarios_Registrados(id);
var urlPofaUser = datosPorId[2]
Logger.log(urlPofaUser);
  var spreadsheet = SpreadsheetApp.openByUrl(urlPofaUser);
  var sheet = spreadsheet.getSheetByName("CONF");
  var range = sheet.getRange(rango); // Ajusta el rango según lo que necesites mostrar
  var values = range.getValues();
  Logger.log(values)
  return values;
}


function getDataCargos(id,rango='A3:j20') {
   var datosPorId = obtenerDatos_Usuarios_Registrados(id);
var urlPofaUser = datosPorId[2]
Logger.log(urlPofaUser);
  var spreadsheet = SpreadsheetApp.openByUrl(urlPofaUser);
  var sheet = spreadsheet.getSheetByName("CARGOS");
  var range = sheet.getRange(rango); // Ajusta el rango según lo que necesites mostrar
  var values = range.getValues();
  return values;
}

function getDataEfi(rango='A3:N3',id) {
   var datosPorId = obtenerDatos_Usuarios_Registrados(id);
var urlPofaUser = datosPorId[2]
Logger.log(urlPofaUser);
  var spreadsheet = SpreadsheetApp.openByUrl(urlPofaUser);
  var sheet = spreadsheet.getSheetByName("EFC");
  if (!sheet) {
    throw new Error('La hoja "CONTRATURNO" no existe.');
  }
  var range = sheet.getRange(rango); // Ajusta el rango según lo que necesites mostrar
  var values = range.getValues();
  return values;
}

function getDataContraturno(rango='A3:N3',id) {
   var datosPorId = obtenerDatos_Usuarios_Registrados(id);
var urlPofaUser = datosPorId[2]
Logger.log(urlPofaUser);
  var spreadsheet = SpreadsheetApp.openByUrl(urlPofaUser);
  var sheet = spreadsheet.getSheetByName("CONTRATURNO");
  if (!sheet) {
    throw new Error('La hoja "CONTRATURNO" no existe.');
  }
  var range = sheet.getRange(rango); // Ajusta el rango según lo que necesites mostrar
  var values = range.getValues();
  return values;
}


//codigo para actualizar el numero de versión cuando haya un cambio

function getVersionHorarios(id) {
  var datosPorId=obtenerDatos_Usuarios_Registrados(id)
var urlObtenida=datosPorId[2];
  var spreadsheet = SpreadsheetApp.openByUrl(urlObtenida);
  var sheet = spreadsheet.getSheetByName("CONF");
  
  if (!sheet) {
    Logger.log("La hoja 'CONF' no existe.");
    return null;
  }

  var versionCell = sheet.getRange(VERSION_CELL);
  var versionValue = versionCell.getValue();

  Logger.log("Versión obtenida: " + versionValue); // Muestra el valor en la consola
  return versionValue;
}


function getVersion(id) {
  var datosPorId=obtenerDatos_Usuarios_Registrados(id)
var urlObtenida=datosPorId[2];
  var spreadsheet = SpreadsheetApp.openByUrl(urlObtenida);
  var sheet = spreadsheet.getSheetByName("POFA");
  
  if (!sheet) {
    Logger.log("La hoja 'POFA' no existe.");
    return null;
  }

  var versionCell = sheet.getRange(VERSION_CELL);
  var versionValue = versionCell.getValue();

  Logger.log("Versión obtenida: " + versionValue); // Muestra el valor en la consola
  return versionValue;
}



function getVersionCargos(id) {
  var datosPorId=obtenerDatos_Usuarios_Registrados(id)
var urlObtenida=datosPorId[2];
  var spreadsheet = SpreadsheetApp.openByUrl(urlObtenida);
  var sheet = spreadsheet.getSheetByName("CARGOS");
  var versionCell = sheet.getRange(VERSION_CELL);
  return versionCell.getValue();
}