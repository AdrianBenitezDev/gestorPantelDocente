function obtenerUrlBase() {
  return ScriptApp.getService().getUrl();
}

//formulario solo para registro
//https://docs.google.com/spreadsheets/d/1WS4E-ugQdHwn9OkyyUYxR9JHE9bimCfswxfsshJbGOI/edit?gid=0#gid=0

let URL_EXCEL_ESCUELAS_DATOS_USUARIOS_SOLO_REGISTRO="https://docs.google.com/spreadsheets/d/1WS4E-ugQdHwn9OkyyUYxR9JHE9bimCfswxfsshJbGOI/edit?gid=0#gid=0";


function generarPlanillaPof() {
    // Obtener email del usuario activo
  const emailUsuario = Session.getActiveUser().getEmail();

//Plantilla de horarios de escuela, se crea una copia
  const plantillaId = "1RvRb0Z0reGI1xmXxOR2u37tbhMH1g8lZzFdBAXUxA6w";
  const nuevoNombre = "APP HORARIOS "+ emailUsuario + " - " + new Date().toLocaleString();

  const archivoCopia = DriveApp.getFileById(plantillaId).makeCopy(nuevoNombre);



  // Compartir con el usuario
  archivoCopia.addEditor(emailUsuario);

  // Opcional: enviarle el enlace por correo
  GmailApp.sendEmail(emailUsuario, "Tu nueva planilla POF", 
    `Hola, aquí está tu copia de la base de datos:\n\n${archivoCopia.getUrl()}`);

  return archivoCopia.getUrl();
}

//recibimos los datos de registro y enviamos mail de verificación
function registrarUsuario(datos){
  //verificamos si el usuario no se encuentra registrado
  var sheet=SpreadsheetApp.openByUrl(URL_EXCEL_ESCUELAS_DATOS_USUARIOS_SOLO_REGISTRO);
  const data = sheet.getDataRange().getValues(); // Esto obtiene toda la tabla

let registrado=false;

for (i=0;i==data.length;i++){

      if(fila[1]==datos.correo){
        
        registrado=true;
        break
      }
  }
  if(registrado){

    return "ya se encuentra registrado ese correo institucional";

  }else{

    //creamos un id para los id user
     var idUser=Math.floor(10000 + Math.random() * 90000).toString(); // Devuelve un número de 5 dígitos como string
    //verificamos si el codigo ya se encuentra creado

    

    
  //creamos un codigo de verificación que enviaremos al correo electronico indicado y ademas lo guardaremos en la tabla
   var codeVerificacion=Math.floor(10000 + Math.random() * 90000).toString(); // Devuelve un número de 5 dígitos como string

  //guardamos los datos con el codigo de verigicación en la tabla
  sheet.appendRow([
    idUser,
    datos.correo,
    "url sin registrar",
    false,
    datos.usuario,
    datos.password,
    codeVerificacion,//introducimos el codigo de verifocacion
    datos.contacto,
    datos.correoAlt,
    datos.escuela,
    datos.distrito,
    datos.nivel,
    datos.numEscuela,
    datos.nombre,
    new Date()
  ]);


  //enviamos el correo electronico con el codigo para acceder
  let sendCorreo=enviarCorreoAlUsuario(datos,codeVerificacion)

  if(sendCorreo){
    return "se envio un correo electronico con el codigo de acceso, al mail proporcionado"
  }else{
    return "ocurrio un error inesperado al envial el acceso al correo proporcionado"
  }

  }


}

function enviarCorreoAlUsuario(datos,codigoVerificacion) {
  // Obtener el correo del usuario actual desde UserProperties o Session
  var usuario = JSON.parse(PropertiesService.getUserProperties().getProperty('userData') || '{}');
  var destinatario = usuario.mail || Session.getActiveUser().getEmail();

  if (!destinatario) {
    Logger.log("No se pudo determinar el correo del usuario.");
    return false;
  }

  // Crear plantilla y pasarle el dato
  const template = HtmlService.createTemplateFromFile('modeloMail');
  template.nombre = datos.nombre;
  template.code=codigoVerificacion;
  template.baseUrl=obtenerUrlBase();
  const html = template.evaluate().getContent();

try{
   // Enviar el correo
  GmailApp.sendEmail(destinatario, ' Verificación de correo electronico', '', {
    htmlBody: html
  });

  Logger.log("Correo enviado a: " + destinatario);

  return true;
}catch (error){

  return false;
}
 
}


function verificarCodigoDesdeWeb(code){

var libro = SpreadsheetApp.openByUrl(URL_EXCEL_ESCUELAS_DATOS_USUARIOS_SOLO_REGISTRO);
var sheet = libro.getSheetByName("data"); // Reemplazá con el nombre real
const datos = sheet.getDataRange().getValues();

  const destinatario = Session.getActiveUser().getEmail();
  let userVerificado = false;
  let urlFinal=""

  for (let i = 2; i < datos.length; i++) {
    const fila = datos[i];
    const correo1 = fila[1]; // Correo principal
    const correoAlt = fila[8]; // Correo alternativo
    const codigo = fila[6]; // Código de verificación
    const yaVerificado = fila[3]; // Supuesto campo booleano de verificación

Logger.log("------------------")
  
  Logger.log(yaVerificado)
  Logger.log(correo1)
  Logger.log(destinatario)
  Logger.log(codigo)
  Logger.log(code)

Logger.log("------------------")

    if (yaVerificado== false && (correo1 == destinatario || correoAlt == destinatario) && codigo == code) {
      sheet.getRange(i + 1, 4).setValue(true); // Columna 4 = índice 3 en array (verificado)
      userVerificado = true;

//creamos el archivo de datos si se verifico el correo electronico

      if(fila[2]=="url sin registrar"){
          let urlGenerada=generarPlanillaPof();
          sheet.getRange(i + 1, 3).setValue(urlGenerada);
      }

      break;
    }
  }

  return userVerificado;
}


