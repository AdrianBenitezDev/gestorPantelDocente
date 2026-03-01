
function traerCursosEscuela(urlPofaUser="https://docs.google.com/spreadsheets/d/1SEbOsjbAkOWNfO_kKMd1B-sMgOFGkWKHjQze-zTr0cE/edit?gid=592042770#gid=592042770"){


  
  var spreadsheet = SpreadsheetApp.openByUrl(urlPofaUser);
  var sheet = spreadsheet.getSheetByName("CONF");

    var curso = sheet.getRange("F3:K50");
    var dato = curso.getValues();

    console.log(dato)

//{"seccion":dato,"turno":"T","id":"1","curso":"1"}

   var newObjeto={"cantidadcursos":[],"tipoIdentificacionSecciones":[],
    "cursos":[]};

    newObjeto.tipoIdentificacionSecciones=dato[0][5];

  
    let curso1=dato[0][0];
    let seccionAcomp=1;
  
    for (var i=0;i<dato.length;i++){
      
      if(dato[i][4]!==''){
      newObjeto.cantidadcursos.push(dato[i][4]);
      }

      if(dato[i][0]!==curso1){
        seccionAcomp=1;
        curso1=dato[i][0];
      }
      var id=dato[i][0]+""+seccionAcomp;
if(dato[i][0]!==''){
  newObjeto.cursos.push({"seccion":dato[i][1],"turno":dato[i][2],"id":id,"curso":dato[i][0]})

}

      seccionAcomp++;
    }
     // console.log(newObjeto)
  // Convertir a JSON (opcional)
  //var res = JSON.stringify(newObjeto);
return newObjeto
  return res;

  let ss={"cantidadcursos":["1","2","3","0","0","0","0","0","0"],"tipoIdentificacionSecciones":"Numéricamente","cursos":[{"seccion":"1","turno":"T","id":"1","curso":"1"},{"curso":3,"seccion":"1°","turno":"M","id":"31"},{"curso":3,"seccion":"2°","turno":"M","id":"32"},{"curso":3,"seccion":"3°","turno":"M","id":"33"},{"curso":2,"seccion":"1°","turno":"M","id":"21"},{"curso":2,"seccion":"2°","turno":"M","id":"22"}]};
  
}
function actualizarCursosBackend(urlPofaUser, datos) {
  const spreadsheet = SpreadsheetApp.openByUrl(urlPofaUser);
  const sheet = spreadsheet.getSheetByName("CONF");

  // Limpia el rango previo (opcional, para evitar restos de datos)
  sheet.getRange("F3:K50").clearContent();

let cc=['1ro',
'2do',
'3ro',
'4to' ,
'5to' ,
'6to',
'7mo']

  // Construir las filas para escribir
  const filas = datos.cursos.map((c,index) =>{
    
return  [c.curso, c.seccion, c.turno,cc[index],datos.cantidadcursos[index]||'']
    
  } );
  // Escribir los cursos en la hoja a partir de la fila 3
  if (filas.length > 0) {
    sheet.getRange(3, 6, filas.length, 5).setValues(filas); // Desde columna F (6)
  }

  // Escribir el tipo de identificación (columna K, fila 3)
  sheet.getRange("K3").setValue(datos.tipoIdentificacionSecciones);


  return "Cursos actualizados correctamente en la hoja CONF";
}