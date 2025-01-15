const fs = require('fs');
const path = require('path');

//const logFilePath = path.join(__dirname, 'app.log');

function logMessage(level, message, ...optionalParams) {
  const timestamp = new Date().toISOString();
  let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;

  if (optionalParams.length > 0) {
    const formattedParams = optionalParams.map((param) =>
      typeof param === 'object' ? JSON.stringify(param, null, 2) : param
    );
    log += ` ${formattedParams.join(' ')}`;
  }
  log += '\n';

  if(level === 'error') {
    console.error(log.trim());
  }
  else if(level === 'debug') {
    console.debug(log.trim());
  }
  else {
    console.log(log.trim());
  }

  /*fs.appendFile(logFilePath, log, (err) => {
    if (err) {
      console.error('Failed to write to log file:', err);
    }
  });*/
}

module.exports = {
    info: (message, ...optionalParams) => logMessage('info', message, ...optionalParams),
    debug: (message, ...optionalParams) => logMessage('debug', message, ...optionalParams),
    error: (message, ...optionalParams) => logMessage('error', message, ...optionalParams)
};
