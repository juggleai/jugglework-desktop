/*
* JuggleCall.js v1.0.0
* (c) 2022-2026 JuggleCall
* Released under the MIT License.
*/
const noop = () => {};
const isObject = obj => {
  return Object.prototype.toString.call(obj) === '[object Object]';
};
const isArray = arr => {
  return Object.prototype.toString.call(arr) === '[object Array]';
};
const isFunction = arr => {
  return Object.prototype.toString.call(arr) === '[object Function]';
};
const isString = str => {
  return Object.prototype.toString.call(str) === '[object String]';
};
const isBoolean = str => {
  return Object.prototype.toString.call(str) === '[object Boolean]';
};
const isUndefined = str => {
  return Object.prototype.toString.call(str) === '[object Undefined]';
};
const isNull = str => {
  return Object.prototype.toString.call(str) === '[object Null]';
};
const isNumber = str => {
  return Object.prototype.toString.call(str) === '[object Number]';
};
const _isNaN = str => {
  return isNaN(Number(str));
};
const stringify = obj => {
  return JSON.stringify(obj);
};
const parse = str => {
  let obj = {};
  try {
    obj = JSON.parse(str);
  } catch (e) {
    obj = str;
  }
  return obj;
};
const forEach = (obj, callback) => {
  callback = callback || noop;
  let loopObj = () => {
    for (var key in obj) {
      callback(obj[key], key, obj);
    }
  };
  var loopArr = () => {
    for (var i = 0, len = obj.length; i < len; i++) {
      callback(obj[i], i, obj);
    }
  };
  if (isObject(obj)) {
    loopObj();
  }
  if (isArray(obj)) {
    loopArr();
  }
};
const isEmpty = obj => {
  let result = true;
  if (isObject(obj)) {
    forEach(obj, () => {
      result = false;
    });
  }
  if (isString(obj) || isArray(obj)) {
    result = obj.length === 0;
  }
  if (isNumber(obj)) {
    result = obj === -1;
  }
  return result;
};
const rename = (origin, newNames) => {
  var isObj = isObject(origin);
  if (isObj) {
    origin = [origin];
  }
  origin = parse(stringify(origin));
  var updateProperty = function (val, key, obj) {
    delete obj[key];
    key = newNames[key];
    obj[key] = val;
  };
  forEach(origin, item => {
    forEach(item, (val, key, obj) => {
      var isRename = key in newNames;
      (isRename ? updateProperty : noop)(val, key, obj);
    });
  });
  return isObject ? origin[0] : origin;
};
const extend = (destination, sources) => {
  sources = isArray(sources) ? sources : [sources];
  forEach(sources, source => {
    for (let key in source) {
      let value = source[key];
      if (!isUndefined(value)) {
        destination[key] = value;
      }
    }
  });
  return destination;
};
const Defer = Promise;
const deferred = callback => {
  return new Defer(callback);
};
const templateFormat = (tpl, data, regexp) => {
  if (!isArray(data)) {
    data = [data];
  }
  let ret = [];
  let replaceAction = object => {
    return tpl.replace(regexp || /\\?\{([^}]+)\}/g, (match, name) => {
      if (match.charAt(0) === '\\') return match.slice(1);
      return object[name] !== undefined ? object[name] : '{' + name + '}';
    });
  };
  for (let i = 0, j = data.length; i < j; i++) {
    ret.push(replaceAction(data[i]));
  }
  return ret.join('');
};
// 暂时支持 String
const isContain = (str, keyword) => {
  return str.indexOf(keyword) > -1;
};
const isEqual = (source, target) => {
  return source === target;
};
const Cache = cache => {
  if (!isObject(cache)) {
    cache = {};
  }
  let set = (key, value) => {
    cache[key] = value;
  };
  let get = key => {
    return cache[key];
  };
  let remove = key => {
    delete cache[key];
  };
  let getKeys = () => {
    let keys = [];
    for (let key in cache) {
      keys.push(key);
    }
    return keys;
  };
  let clear = () => {
    cache = {};
  };
  return {
    set,
    get,
    remove,
    getKeys,
    clear
  };
};
const request = (url, option) => {
  return deferred((resolve, reject) => {
    requestNormal(url, option, {
      success: resolve,
      fail: reject
    });
  });
};
const requestNormal = (url, option, callback) => {
  option = option || {};
  callback = callback || {
    success: noop,
    fail: noop,
    progress: noop
  };
  let xhr = new XMLHttpRequest();
  let method = option.method || 'GET';
  xhr.open(method, url, true);
  let headers = option.headers || {};
  forEach(headers, (header, name) => {
    xhr.setRequestHeader(name, header);
  });
  let body = option.body || {};
  let isSuccess = () => {
    return /^(200|202)$/.test(xhr.status);
  };
  let timeout = option.timeout;
  if (timeout) {
    xhr.timeout = timeout;
  }
  xhr.onreadystatechange = function () {
    if (isEqual(xhr.readyState, 4)) {
      let {
        responseText
      } = xhr;
      responseText = responseText || '{}';
      let result = parse(responseText);
      if (isSuccess()) {
        callback.success(result, xhr);
      } else {
        let {
          status
        } = xhr;
        let error = {
          status,
          result
        };
        callback.fail(error);
      }
    }
  };
  xhr.upload.onprogress = function (event) {
    if (event.lengthComputable) {
      callback.progress(event);
    }
  };
  xhr.onerror = error => {
    callback.fail(error);
  };
  xhr.send(body);
  return xhr;
};
const map = (arrs, callback) => {
  return arrs.map(callback);
};
const filter = (arrs, callback) => {
  return arrs.filter(callback);
};
const uniq = (arrs, callback) => {
  let newData = [],
    tempData = {};
  arrs.forEach(target => {
    let temp = callback(target);
    tempData[temp.key] = temp.value;
  });
  forEach(tempData, val => {
    newData.push(val);
  });
  return newData;
};
const some = (arrs, callback) => {
  return arrs.some(callback);
};
const toJSON = value => {
  return JSON.stringify(value);
};
const toArray = obj => {
  let arrs = [];
  forEach(obj, (v, k) => {
    arrs.push([k, v]);
  });
  return arrs;
};
const isInclude = (str, match) => {
  return str.indexOf(match) > -1;
};
const clone = source => {
  return JSON.parse(JSON.stringify(source));
};
function Index() {
  let index = 0;
  this.add = () => {
    index += 1;
  };
  this.get = () => {
    return index;
  };
  this.reset = () => {
    index = 0;
  };
}
function Observer() {
  let observers = [];
  this.add = (observer, force) => {
    if (isFunction(observer)) {
      if (force) {
        return observers = [observer];
      }
      observers.push(observer);
    }
  };
  this.remove = observer => {
    observers = filter(observers, _observer => {
      return _observer !== observer;
    });
  };
  this.emit = data => {
    forEach(observers, observer => {
      observer(data);
    });
  };
}
function Prosumer() {
  let data = [],
    isConsuming = false;
  this.produce = res => {
    data.push(res);
  };
  this.consume = (callback, finished) => {
    if (isConsuming) {
      return;
    }
    isConsuming = true;
    let next = () => {
      let res = data.shift();
      if (isUndefined(res)) {
        isConsuming = false;
        finished && finished();
        return;
      }
      callback(res, next);
    };
    next();
  };
  this.isExeuting = function () {
    return isConsuming;
  };
}
const getBrowser = () => {
  let userAgent = navigator.userAgent;
  let name = '',
    version = '';
  if (/(Msie|Firefox|Opera|Chrome|Netscape)\D+(\d[\d.]*)/.test(userAgent)) {
    name = RegExp.$1;
    version = RegExp.$2;
  }
  if (/Version\D+(\d[\d.]*).*Safari/.test(userAgent)) {
    name = 'Safari';
    version = RegExp.$1;
  }
  return {
    name,
    version
  };
};
const getUUID = () => {
  return 'j' + 'xxxx-xxxx-xxxx-xxxx'.replace(/[xy]/g, function (c) {
    let r = Math.random() * 16 | 0,
      v = c == 'x' ? r : r & 0x3 | 0x8;
    return v.toString(16);
  });
};
const getProtocol = (url = '') => {
  let http = location.protocol;
  if (isEqual(http, 'file:')) {
    http = 'http:';
  }
  if (isInclude(url, 'https://')) {
    http = 'https:';
  }
  let wsMap = {
    'http:': 'ws:',
    'https:': 'wss:'
  };
  let ws = wsMap[http];
  return {
    http,
    ws
  };
};
const sort = (arrs, callback) => {
  const len = arrs.length;
  if (len < 2) {
    return arrs;
  }
  for (let i = 0; i < len - 1; i++) {
    for (let j = i + 1; j < len; j++) {
      if (callback(arrs[j], arrs[i])) {
        [arrs[i], arrs[j]] = [arrs[j], arrs[i]];
      }
    }
  }
  return arrs;
};
const quickSort = (arr, callback) => {
  if (arr.length < 2) {
    return arr;
  }
  let pivot = arr[0];
  let left = [];
  let right = [];
  for (let i = 1; i < arr.length; i++) {
    if (callback(arr[i], pivot)) {
      left.push(arr[i]);
    } else {
      right.push(arr[i]);
    }
  }
  return [...quickSort(left, callback), pivot, ...quickSort(right, callback)];
};
const find = (arrs, callback) => {
  let len = arrs.length;
  let index = -1;
  for (let i = 0; i < len; i++) {
    let item = arrs[i];
    if (callback(item)) {
      index = i;
      break;
    }
  }
  return index;
};
const toObject = arrs => {
  let objs = {};
  forEach(arrs, (item = {}) => {
    let key = item.key;
    let value = item.value;
    objs[key] = value;
  });
  return objs;
};
const decodeBase64 = function (input) {
  let _keyStr = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  let output = "";
  let chr1, chr2, chr3;
  let enc1, enc2, enc3, enc4;
  let i = 0;
  input = input.replace(/[^A-Za-z0-9\+\/\=]/g, "");
  while (i < input.length) {
    enc1 = _keyStr.indexOf(input.charAt(i++));
    enc2 = _keyStr.indexOf(input.charAt(i++));
    enc3 = _keyStr.indexOf(input.charAt(i++));
    enc4 = _keyStr.indexOf(input.charAt(i++));
    chr1 = enc1 << 2 | enc2 >> 4;
    chr2 = (enc2 & 15) << 4 | enc3 >> 2;
    chr3 = (enc3 & 3) << 6 | enc4;
    output += String.fromCharCode(chr1);
    if (enc3 !== 64) {
      output += String.fromCharCode(chr2);
    }
    if (enc4 !== 64) {
      output += String.fromCharCode(chr3);
    }
  }
  return output;
};
const isContinuous = (numbers, key) => {
  numbers.sort((a, b) => {
    return a[key] - b[key];
  });
  for (let i = 0; i < numbers.length - 1; i++) {
    if (!isEmpty(numbers[i + 1][key])) {
      if (numbers[i + 1][key] !== numbers[i][key] + 1) {
        return false;
      }
    }
  }
  return true;
};
const isBase64 = str => {
  var regex = /^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)?$/;
  return regex.test(str);
};
function iterator(list, callback) {
  let next = () => {
    let item = list.splice(0, 1);
    if (isEmpty(item)) {
      return;
    }
    let isFinished = isEqual(list.length, 0);
    callback(item[0], next, isFinished);
  };
  next();
}
function formatTime(time, fmt = 'yyyy-MM-dd hh:mm:ss') {
  let date = new Date(time);
  var o = {
    "M+": date.getMonth() + 1,
    // 月份
    "d+": date.getDate(),
    // 日
    "h+": date.getHours(),
    // 小时
    "m+": date.getMinutes(),
    // 分
    "s+": date.getSeconds(),
    // 秒
    "q+": Math.floor((date.getMonth() + 3) / 3),
    // 季度
    "S": date.getMilliseconds() // 毫秒
  };
  if (/(y+)/.test(fmt)) fmt = fmt.replace(RegExp.$1, (date.getFullYear() + "").substr(4 - RegExp.$1.length));
  for (var k in o) if (new RegExp("(" + k + ")").test(fmt)) fmt = fmt.replace(RegExp.$1, RegExp.$1.length == 1 ? o[k] : ("00" + o[k]).substr(("" + o[k]).length));
  return fmt;
}
function isValidHMTime(timeStr) {
  const regex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
  return regex.test(timeStr);
}
function getRandoms(len) {
  return Array(len).fill(0).map(() => Math.floor(Math.random() * 10));
}
// input: groupBy([{a:1},{a:1}, {a:2}], ['a'])
// output: { 1: [{a:1},{a:1}], 2: [{a:2}] }
let groupBy = (arrs, keys) => {
  let obj = {};
  forEach(arrs, item => {
    let names = [];
    forEach(item, (v, k) => {
      if (isInclude(keys, k)) {
        names.push(v);
      }
    });
    let name = names.join('_');
    let _list = obj[name] || [];
    _list.push(item);
    obj[name] = _list;
  });
  return obj;
};
var utils = {
  Prosumer,
  Observer,
  isUndefined,
  isBoolean,
  isString,
  isObject,
  isArray,
  isFunction,
  stringify,
  parse,
  rename,
  extend,
  clone,
  deferred,
  Defer,
  forEach,
  templateFormat,
  isContain,
  noop,
  Cache,
  request,
  map,
  filter,
  uniq,
  some,
  isEqual,
  isEmpty,
  toJSON,
  isInclude,
  isNull,
  isNumber,
  toArray,
  Index,
  getBrowser,
  getUUID,
  requestNormal,
  getProtocol,
  sort,
  find,
  quickSort,
  toObject,
  decodeBase64,
  isContinuous,
  isBase64,
  iterator,
  formatTime,
  isValidHMTime,
  getRandoms,
  groupBy,
  isNaN: _isNaN
};

let CALL_STATUS = {
  IDLE: 0,
  OUTGOING: 1,
  INCOMING: 2,
  CONNECTING: 3,
  CONNECTED: 4,
  DISCONNECTED: 5
};
let CALL_SERVER_REASON = {
  // 主叫取消
  CALLER_CANCEL: 0,
  // 被叫拒绝
  CALLEE_DECLINE: 1,
  // 被叫无答应
  CALLEE_NO_RESPONSE: 2,
  // 通话完成
  CALL_FINISHED: 3
};
let CALL_SERVER_QUIT_REASON = {
  PING_TIMEOUT: 2
};
let CALL_FINISHED_REASON = {
  // 默认状态
  IDLE: -1,
  // 未知原因
  UNKOWN: 0,
  // 当前用户挂断已接通的来电
  HANGUP: 1,
  // 当前用户拒接来电
  DECLINE: 2,
  // 当前用户忙线
  BUSY: 3,
  // 当前用户未接听
  NO_RESPONSE: 4,
  // 当前用户取消呼叫
  CANCEL: 5,
  // 对端用户挂断已接通的来电
  OTHER_SIDE_HANGUP: 6,
  // 对端用户拒接来电
  OTHER_SIDE_DECLINE: 7,
  // 对端用户忙线
  OTHER_SIDE_BUSY: 8,
  // 对端用户未接听
  OTHER_SIDE_NO_RESPONSE: 9,
  // 对端用户取消呼叫
  OTHER_SIDE_CANCEL: 10,
  // 房间被销毁
  ROOM_DESTROY: 11,
  // 网络出错
  NETWORK_ERROR: 12
};
let SIGNAL_NAME = {
  RTC_ROOM_EVENT: 'rtc_room_event',
  RTC_INVITE_EVENT: 'rtc_invite_event',
  RTC_FINISHED_1V1_EVENT: 'rtc_finished_1v1_event',
  RTC_CALL_CONNECTED: 'rtc_call_connected',
  RTC_CALL_FINISHED: 'rtc_call_finished',
  RTC_CALL_ERROR: 'rtc_call_error',
  RTC_MEMBER_JOINED: 'rtc_call_member_joined',
  RTC_MEMBER_QUIT: 'rtc_call_member_quit',
  RTC_CAMERA_CHANGED: 'rtc_call_camera_changed',
  RTC_MICROPHONE_CHANGED: 'rtc_call_microhpone_changed'
};
let EVENT_NAME = {
  // 建立通话且 RTC 推拉成功后触发，多人通话有一人接通后触发，只触发一次
  CALL_CONNECTED: 'call_connected',
  // 通话结束后触发
  CALL_FINISHED: 'call_finished',
  // 通话失败
  CALL_ERROR: 'call_error',
  INVITED: 'call_invited',
  MEMBER_JOINED: 'call_member_joined',
  MEMBER_QUIT: 'call_member_quit',
  CAMERA_CHANGED: 'call_camera_changed',
  MICROPHONE_CHANGED: 'call_microhpone_changed'
};
let FUNC_PARAM_CHECKER = {
  START_SIGNLE_CALL: [{
    name: 'memberId'
  }],
  START_MULTI_CALL: [{
    name: 'memberIds',
    type: 'Array'
  }],
  INVITE_USERS: [{
    name: 'memberIds',
    type: 'Array'
  }]
};
let ROOM_TYPE = {
  ONE_ONE: 0,
  ONE_MORE: 1
};
let MEDIA_TYPE = {
  AUDIO: 0,
  VIDEO: 1
};
let ErrorMessages = [{
  code: 25000,
  msg: '参数缺失，请检查传入参数',
  name: 'ILLEGAL_PARAMS'
}, {
  code: 25002,
  msg: '连接不存在',
  name: 'CONNECTION_NOT_READY'
}, {
  code: 25003,
  msg: '参数类型不正确',
  name: 'ILLEGAL_TYPE_PARAMS'
}, {
  code: 25013,
  msg: '参数不可为空，请检查传入参数',
  name: 'ILLEGAL_PARAMS_EMPTY'
}, {
  code: 40000,
  msg: '忙碌中',
  name: 'RTC_IS_BUSY'
}, {
  code: 40001,
  msg: '加入 RTC 房间失败',
  name: 'RTC_JOIN_FAILED'
}, {
  code: 40002,
  msg: '加入 RTC 房间失败，设备未授权',
  name: 'RTC_DEVICE_NOT_ALLOWED'
}, {
  code: 0,
  msg: '内部业务调用成功',
  name: 'COMMAND_SUCCESS'
}];
let INVITE_TYPE = {
  INVITE: 0,
  ACCEPT: 1,
  HANGUP: 2
};
let ROOM_EVENT_TYPE = {
  JOINED: 1,
  QUIT: 2,
  DESTROY: 3,
  STATECHANGED: 4
};
function getErrorType() {
  let errors = {};
  utils.forEach(ErrorMessages, error => {
    let {
      name,
      code,
      msg
    } = error;
    errors[name] = {
      code,
      msg
    };
  });
  return errors;
}
let ErrorType = getErrorType();

/* 
var fsm = StateMachine({
  initState: 'solid',
  transitions: [
    { name: 'melt',     from: 'solid',  to: 'liquid' },
    { name: 'freeze',   from: 'liquid', to: 'solid'  },
    { name: 'vaporize', from: 'liquid', to: 'gas'    },
    { name: 'reset',    from: 'any', to: 'solid'    },
  ],
  methods: {
    onmelt:     function() { console.log('I melted')    },
    onfreeze:   function() { console.log('I froze')     },
    onvaporize: function() { console.log('I vaporized') }
  }
});
*/
function StateMachine (options) {
  let _machine = {};
  let _state = -1;
  let {
    initState,
    transitions,
    methods
  } = options;
  _state = initState;
  transitions.forEach(tran => {
    let {
      name,
      from,
      to
    } = tran;
    from = utils.isArray(from) ? from : [from];
    _machine[name] = target => {
      return utils.deferred((resolve, reject) => {
        if (utils.isInclude(from, _state)) {
          let beforeName = `on${name}before`;
          let isKeep = false;
          let func = methods[beforeName];
          if (func) {
            isKeep = func();
          }
          if (!isKeep) {
            _state = to;
          }
          let eventName = `on${name}`;
          let event = methods[eventName] || utils.noop;
          event({
            target,
            resolve,
            reject
          });
        } else {
          reject(ErrorType.RTC_IS_BUSY);
        }
      });
    };
  });
  _machine.getState = () => {
    return _state;
  };
  return _machine;
}

let check = (io, _params, props, isStatic, option = {}) => {
  if (!isStatic) {
    if (!io.isConnected()) {
      return ErrorType.CONNECTION_NOT_READY;
    }
  }
  let {
    isChild,
    isArray
  } = option;
  _params = _params || {};
  let checkType = (val, type, name) => {
    let error = null;
    let {
      msg,
      code
    } = ErrorType.ILLEGAL_TYPE_PARAMS;
    let _type = Object.prototype.toString.call(val);
    _type = _type.slice(8, _type.length - 1);
    if (!utils.isEqual(_type, type)) {
      msg = `${name} ${msg}, 传入 ${_type}, 应传: ${type}`;
      error = {
        msg,
        code
      };
    }
    return error;
  };
  let checkEmpty = (val, type, name) => {
    let error = null;
    let {
      msg,
      code
    } = ErrorType.ILLEGAL_PARAMS_EMPTY;
    if (utils.isEmpty(val)) {
      msg = `${name} ${msg}`;
      error = {
        msg,
        code
      };
    }
    return error;
  };
  let checkRequire = (val, name, index) => {
    let error = null;
    let {
      msg,
      code
    } = ErrorType.ILLEGAL_PARAMS;
    if (utils.isUndefined(val)) {
      msg = `${name} ${msg}`;
      if (!isChild && utils.isArray(_params)) {
        msg = `Array index ${index} : ${msg}`;
      }
      if (isChild && isArray) {
        msg = `${option.name}[${option.num}].${msg}`;
      }
      if (isChild && !isArray) {
        msg = `${option.name}.${msg}`;
      }
      error = {
        msg,
        code
      };
    }
    return error;
  };
  let _check = (prop, param, index) => {
    let {
      name,
      type,
      children
    } = prop;
    let val = param[name];
    let error = null;
    error = checkRequire(val, name, index);
    if (error) {
      return error;
    }
    if (type) {
      error = checkType(val, type, name);
      if (!error) {
        error = checkEmpty(val, type, name);
      }
      if (!error && !utils.isUndefined(children)) {
        let isArray = utils.isEqual(type, 'Array');
        error = check(io, val, children, isStatic, {
          num: index,
          name: name,
          isChild: true,
          isArray
        });
      }
    }
    return error;
  };
  let params = utils.isArray(_params) ? _params : [_params];
  for (let i = 0; i < props.length; i++) {
    let prop = props[i];
    for (let j = 0; j < params.length; j++) {
      let param = params[j];
      let error = _check(prop, param, j);
      if (error) {
        return error;
      }
    }
  }
};
let getFinishReason = (member, isSelfHangup) => {
  let {
    status,
    isTimeout
  } = member;
  let reason = CALL_FINISHED_REASON.IDLE;
  if (isSelfHangup) {
    if (utils.isEqual(CALL_STATUS.INCOMING, status) && isTimeout) {
      reason = CALL_FINISHED_REASON.NO_RESPONSE;
    } else if (utils.isEqual(CALL_STATUS.OUTGOING, status)) {
      reason = CALL_FINISHED_REASON.CANCEL;
    } else if (utils.isEqual(CALL_STATUS.INCOMING, status)) {
      reason = CALL_FINISHED_REASON.DECLINE;
    } else {
      reason = CALL_FINISHED_REASON.HANGUP;
    }
  }
  if (!isSelfHangup) {
    if (utils.isEqual(CALL_STATUS.OUTGOING, status) && isTimeout) {
      reason = CALL_FINISHED_REASON.OTHER_SIDE_NO_RESPONSE;
    } else if (utils.isEqual(CALL_STATUS.INCOMING, status)) {
      reason = CALL_FINISHED_REASON.OTHER_SIDE_CANCEL;
    } else if (utils.isEqual(CALL_STATUS.OUTGOING, status)) {
      reason = CALL_FINISHED_REASON.OTHER_SIDE_DECLINE;
    } else {
      reason = CALL_FINISHED_REASON.OTHER_SIDE_HANGUP;
    }
  }
  return reason;
};
function get1v1Reason(notify) {
  let {
    content: {
      reason: serverReason
    },
    isSender
  } = notify;
  let reason = serverReason;
  if (isSender) {
    if (utils.isEqual(serverReason, CALL_SERVER_REASON.CALLER_CANCEL)) {
      reason = CALL_FINISHED_REASON.CANCEL;
    }
    if (utils.isEqual(serverReason, CALL_SERVER_REASON.CALLEE_DECLINE)) {
      reason = CALL_FINISHED_REASON.OTHER_SIDE_DECLINE;
    }
    if (utils.isEqual(serverReason, CALL_SERVER_REASON.CALLEE_NO_RESPONSE)) {
      reason = CALL_FINISHED_REASON.OTHER_SIDE_NO_RESPONSE;
    }
    if (utils.isEqual(serverReason, CALL_SERVER_REASON.CALL_FINISHED)) {
      reason = CALL_FINISHED_REASON.HANGUP;
    }
  }
  if (!isSender) {
    if (utils.isEqual(serverReason, CALL_SERVER_REASON.CALLER_CANCEL)) {
      reason = CALL_FINISHED_REASON.OTHER_SIDE_CANCEL;
    }
    if (utils.isEqual(serverReason, CALL_SERVER_REASON.CALLEE_DECLINE)) {
      reason = CALL_FINISHED_REASON.DECLINE;
    }
    if (utils.isEqual(serverReason, CALL_SERVER_REASON.CALLEE_NO_RESPONSE)) {
      reason = CALL_FINISHED_REASON.NO_RESPONSE;
    }
    if (utils.isEqual(serverReason, CALL_SERVER_REASON.CALL_FINISHED)) {
      reason = CALL_FINISHED_REASON.HANGUP;
    }
  }
  return reason;
}
var common = {
  check,
  getFinishReason,
  get1v1Reason
};

function Timer (_config = {}) {
  let config = {
    timeout: 1 * 5 * 1000
  };
  utils.extend(config, _config);
  let {
    timeout
  } = config;
  let interval = 0;
  let callback = utils.noop;
  let resume = _callback => {
    callback = _callback;
    interval = setInterval(() => {
      callback();
    }, timeout);
  };
  let pause = () => {
    clearInterval(interval);
  };
  let reset = () => {
    pause();
    resume(callback);
  };
  return {
    resume,
    pause,
    reset
  };
}

function Alarm (_config = {}) {
  let config = {
    timeout: 1 * 35 * 1000
  };
  utils.extend(config, _config);
  let {
    timeout
  } = config;
  let interval = 0;
  let callback = utils.noop;
  let start = (data, _callback) => {
    callback = _callback;
    interval = setTimeout(() => {
      callback(data);
    }, timeout);
  };
  let clear = () => {
    clearTimeout(interval);
  };
  return {
    start,
    clear
  };
}

function CallSession(_info, {
  client,
  rtcEngine,
  emitter: sessionEmitter,
  isNew
}) {
  let callId = utils.getUUID();
  let callInfo = {
    callId: callId,
    isMultiCall: false,
    callStatus: CALL_STATUS.IDLE,
    mediaType: null,
    startTime: 0,
    connectTime: 0,
    finishTime: 0,
    inviter: {},
    // { id: '', status: '连接中|已连接', alarm: Alarm }
    members: [],
    isNew: isNew,
    ext: ''
  };
  callInfo = utils.extend(callInfo, _info);
  let timer = Timer();
  function shouldCreateVideoTrack(options = {}) {
    if (!utils.isUndefined(options.createVideoTrack)) {
      return !!options.createVideoTrack;
    }
    if (!utils.isUndefined(options.allowVideoToggle)) {
      return !!options.allowVideoToggle;
    }
    return utils.isEqual(options.mediaType, MEDIA_TYPE.VIDEO);
  }
  function getMemberMediaState(options = {}) {
    let mediaType = !utils.isUndefined(options.mediaType) ? options.mediaType : getMediaType(options.isEnableCamera);
    let isEnableCamera = !utils.isUndefined(options.isEnableCamera) ? options.isEnableCamera : utils.isEqual(mediaType, MEDIA_TYPE.VIDEO);
    let isMuteMicrophone = !!options.isMuteMicrophone;
    return {
      mediaType,
      isEnableCamera,
      isMuteMicrophone
    };
  }
  var machine = StateMachine({
    initState: CALL_STATUS.IDLE,
    transitions: [
    // 主叫
    {
      name: 'caller',
      from: [CALL_STATUS.IDLE, CALL_STATUS.DISCONNECTED],
      to: CALL_STATUS.OUTGOING
    }, {
      name: 'calleraccepted',
      from: [CALL_STATUS.OUTGOING, CALL_STATUS.CONNECTED],
      to: CALL_STATUS.CONNECTED
    },
    // 主动邀请
    {
      name: 'invite',
      from: [CALL_STATUS.IDLE, CALL_STATUS.OUTGOING, CALL_STATUS.CONNECTED, CALL_STATUS.DISCONNECTED],
      to: CALL_STATUS.OUTGOING
    },
    // 被动邀请：收到成员邀请其他人的通知
    {
      name: 'memberinvite',
      from: [CALL_STATUS.IDLE, CALL_STATUS.OUTGOING, CALL_STATUS.CONNECTED, CALL_STATUS.DISCONNECTED],
      to: CALL_STATUS.CONNECTED
    },
    // 被叫
    {
      name: 'callee',
      from: CALL_STATUS.IDLE,
      to: CALL_STATUS.INCOMING
    }, {
      name: 'accept',
      from: CALL_STATUS.INCOMING,
      to: CALL_STATUS.CONNECTED
    },
    // 主动挂断
    {
      name: 'hangup',
      from: [CALL_STATUS.INCOMING, CALL_STATUS.OUTGOING, CALL_STATUS.CONNECTED],
      to: CALL_STATUS.DISCONNECTED
    },
    // 被动挂断：房间销毁或者 1v1 有人退出，收到通知一方无需再与 IM Server 交互
    {
      name: 'close',
      from: [CALL_STATUS.INCOMING, CALL_STATUS.OUTGOING, CALL_STATUS.CONNECTED],
      to: CALL_STATUS.CONNECTED
    }, {
      name: 'destroy',
      from: [CALL_STATUS.INCOMING, CALL_STATUS.OUTGOING, CALL_STATUS.CONNECTED, CALL_STATUS.DISCONNECTED],
      to: CALL_STATUS.DISCONNECTED
    }],
    methods: {
      oncaller: event => {
        let {
          resolve,
          reject,
          target
        } = event;
        let {
          options: {
            memberIds,
            roomType,
            ext
          }
        } = target;
        let isMultiCall = utils.isEqual(ROOM_TYPE.ONE_MORE, roomType);
        let {
          mediaType,
          isEnableCamera
        } = getMemberMediaState(target.options);
        utils.extend(callInfo, {
          callStatus: machine.getState(),
          isMultiCall,
          mediaType
        });
        let currentUser = client.getCurrentUser();
        let members = utils.map(memberIds, memberId => {
          return {
            id: memberId,
            status: CALL_STATUS.INCOMING
          };
        });
        let status = isMultiCall ? CALL_STATUS.CONNECTED : CALL_STATUS.OUTGOING;
        members.push({
          id: currentUser.id,
          status,
          cameraEnable: isEnableCamera,
          micEnable: !target.options.isMuteMicrophone
        });
        callInfo = utils.extend(callInfo, {
          inviter: currentUser,
          members
        });

        // 启动每个成员的接听计时器，会在 oncalleraccepted 中停止计时
        startMembersTimer({
          callId: callInfo.callId,
          inviter: currentUser,
          members: members
        });
        client.inviteRTC({
          roomId: callInfo.callId,
          roomType: roomType,
          mediaType,
          memberIds: memberIds,
          ext: ext || ''
        }).then(async result => {
          sessionEmitter.emit(SIGNAL_NAME.RTC_MEMBER_JOINED, {
            target: {
              callId: callInfo.callId,
              member: {
                id: currentUser.id
              }
            }
          });
          let {
            auth
          } = result;
          let joinResult = await joinRTCRoom({
            auth,
            options: target.options
          });
          if (joinResult.isJoined) {
            startPing();
            resolve();
          } else {
            reject(joinResult);
          }
        }, reject);
      },
      onmemberinvitebefore: () => {
        // 邀请时，status 是 connected 不再变更状态
        let isKeepStatus = utils.isEqual(callInfo.callStatus, CALL_STATUS.CONNECTED);
        return isKeepStatus;
      },
      onmemberinvite: event => {
        let {
          target: {
            members
          }
        } = event;
        utils.extend(callInfo, {
          callStatus: machine.getState(),
          isMultiCall: true
        });
        let currentUser = client.getCurrentUser();
        utils.forEach(members, member => {
          let index = utils.find(callInfo.members, _member => {
            return _member.id == member.id;
          });
          let notifyMember = {
            id: member.id,
            status: CALL_STATUS.INCOMING
          };
          let tMember = callInfo.members[index];
          if (tMember) {
            callInfo.members.splice(index, 1, notifyMember);
          } else {
            callInfo.members.push(notifyMember);
          }
          sessionEmitter.emit(SIGNAL_NAME.RTC_MEMBER_JOINED, {
            target: {
              callId: callInfo.callId,
              member: {
                id: member.id
              }
            }
          });
        });

        // 启动每个成员的接听计时器，会在 oncalleraccepted 中停止计时
        startMembersTimer({
          callId: callInfo.callId,
          inviter: currentUser,
          members: members
        });
      },
      oninvitebefore: () => {
        // 邀请时，status 是 connected 不再变更状态
        let isKeepStatus = utils.isEqual(callInfo.callStatus, CALL_STATUS.CONNECTED);
        return isKeepStatus;
      },
      oninvite: event => {
        let {
          resolve,
          reject,
          target
        } = event;
        let {
          options: {
            memberIds
          }
        } = target;
        let {
          mediaType
        } = getMemberMediaState(target.options);
        utils.extend(callInfo, {
          callStatus: machine.getState(),
          mediaType,
          isMultiCall: true
        });
        let currentUser = client.getCurrentUser();
        let inviteMembers = [];
        utils.forEach(memberIds, memberId => {
          let member = {
            id: memberId,
            status: CALL_STATUS.INCOMING
          };
          let index = utils.find(callInfo.members, _member => {
            return _member.id == memberId;
          });
          let tMember = callInfo.members[index];
          if (tMember) {
            callInfo.members.splice(index, 1, member);
          } else {
            callInfo.members.push(member);
          }
          inviteMembers.push(member);
        });

        // 启动每个成员的接听计时器，会在 oncalleraccepted 中停止计时
        startMembersTimer({
          callId: callInfo.callId,
          inviter: currentUser,
          members: inviteMembers
        });
        client.inviteRTC({
          roomId: callInfo.callId,
          roomType: ROOM_TYPE.ONE_MORE,
          mediaType,
          memberIds: memberIds
        }).then(result => {
          let _member = getMember(currentUser);
          if (!utils.isEqual(_member.status, CALL_STATUS.CONNECTED)) {
            sessionEmitter.emit(SIGNAL_NAME.RTC_MEMBER_JOINED, {
              target: {
                callId: callInfo.callId,
                member: {
                  id: currentUser.id
                }
              }
            });
          }
          resolve();
        }, reject);
      },
      oncalleraccepted: event => {
        let {
          target: {
            member
          }
        } = event;
        let {
          members
        } = callInfo;
        let user = client.getCurrentUser();
        let list = [member, user];
        utils.forEach(members, _member => {
          utils.forEach(list, item => {
            if (utils.isEqual(item.id, _member.id)) {
              if (!utils.isEqual(_member.status, CALL_STATUS.CONNECTED) && _member.id != user.id) {
                sessionEmitter.emit(SIGNAL_NAME.RTC_MEMBER_JOINED, {
                  target: {
                    callId: callInfo.callId,
                    member: {
                      id: _member.id
                    }
                  }
                });
              }
              updateMember(_member, {
                status: CALL_STATUS.CONNECTED
              });
            }
          });
        });
        stopMemberTimer(member);
        if (!utils.isEqual(callInfo.callStatus, CALL_STATUS.CONNECTED)) {
          utils.extend(callInfo, {
            callStatus: machine.getState()
          });
          sessionEmitter.emit(SIGNAL_NAME.RTC_CALL_CONNECTED, {
            target: {
              callId,
              mediaType: callInfo.mediaType
            }
          });
        }
      },
      oncallee: event => {
        utils.extend(callInfo, {
          callStatus: machine.getState()
        });
        let {
          target: {
            inviter,
            members,
            existsMembers,
            mediaType
          }
        } = event;
        utils.forEach(existsMembers, member => {
          let {
            status
          } = member;
          status = utils.isEqual(status, CALL_STATUS.CONNECTING) ? CALL_STATUS.CONNECTED : status;
          callInfo.members.push({
            ...member,
            status
          });
        });
        utils.forEach(members, member => {
          let index = utils.find(callInfo.members, _member => {
            return utils.isEqual(_member.id, member.id);
          });
          let tMember = {
            ...member,
            status: CALL_STATUS.INCOMING
          };
          if (index > -1) {
            callInfo.members.splice(index, 1, tMember);
          } else {
            callInfo.members.push(tMember);
          }
        });
        let index = utils.find(callInfo.members, member => {
          return utils.isEqual(member.id, inviter.id);
        });
        if (index == -1) {
          callInfo.members.push({
            id: inviter.id,
            status: CALL_STATUS.OUTGOING
          });
        }

        // 信令若未带本端，members 里可能只有主叫；被动挂断时 notifyQuit 需能遍历到本端才会 quitRoom
        let currentUser = client.getCurrentUser();
        if (utils.find(callInfo.members, _member => utils.isEqual(_member.id, currentUser.id)) === -1) {
          callInfo.members.push({
            id: currentUser.id,
            status: CALL_STATUS.INCOMING
          });
        }
        callInfo = utils.extend(callInfo, {
          inviter,
          mediaType
        });
        if (!utils.isEqual(callInfo.callStatus, CALL_STATUS.CONNECTED)) {
          utils.extend(callInfo, {
            callStatus: machine.getState()
          });
          sessionEmitter.emit(SIGNAL_NAME.RTC_CALL_CONNECTED, {
            target: {
              callId,
              mediaType: callInfo.mediaType
            }
          });
        }
        startMembersTimer({
          callId: callInfo.callId,
          inviter: inviter,
          members: callInfo.members
        });
      },
      onaccept: event => {
        utils.extend(callInfo, {
          callStatus: machine.getState()
        });
        let {
          resolve,
          reject,
          target: {
            options
          }
        } = event;

        // 当前用户接听通话，清除计时器
        let user = client.getCurrentUser();
        let list = [user, callInfo.inviter];
        let {
          members
        } = callInfo;
        if (utils.find(members, _member => utils.isEqual(_member.id, user.id)) === -1) {
          callInfo.members.push({
            id: user.id,
            status: CALL_STATUS.INCOMING
          });
        }
        utils.forEach(members, _member => {
          utils.forEach(list, item => {
            if (utils.isEqual(item.id, _member.id)) {
              updateMember(_member, {
                status: CALL_STATUS.CONNECTED
              });
            }
          });
        });
        stopMemberTimer(user);
        client.acceptRTC({
          roomId: callInfo.callId
        }).then(async result => {
          utils.forEach(members, member => {
            sessionEmitter.emit(SIGNAL_NAME.RTC_MEMBER_JOINED, {
              target: {
                callId: callInfo.callId,
                member
              }
            });
          });
          startPing();
          let {
            auth
          } = result;
          let joinResult = await joinRTCRoom({
            auth,
            options
          });
          if (joinResult.isJoined) {
            resolve();
          } else {
            reject(joinResult);
          }
        }, reject);
      },
      onhangup: event => {
        let isSelfHangup = true;
        let user = client.getCurrentUser();
        let _member = getMember(user);
        let reason = common.getFinishReason(_member, isSelfHangup);
        let {
          target: {
            reason: quitReason
          }
        } = event;
        // ping 超时强制转换为网络异常
        if (utils.isEqual(quitReason, CALL_SERVER_QUIT_REASON.PING_TIMEOUT)) {
          reason = CALL_FINISHED_REASON.NETWORK_ERROR;
        }
        utils.extend(callInfo, {
          callStatus: machine.getState(),
          reason
        });
        stopPing();
        let roomId = callInfo.callId;
        console.log('[call-sdk][hangup]', {
          step: 'session-onhangup',
          roomId,
          mode: callInfo.isMultiCall ? 'multi' : '1v1',
          mediaType: callInfo.mediaType,
          localUserId: user.id,
          reason,
          rtcAction: 'quitRoom+hangupRTC'
        });
        client.hangupRTC({
          id: roomId
        }).catch(utils.noop);
        rtcEngine.quitRoom({
          roomId
        });
        utils.forEach(callInfo.members, member => {
          stopMemberTimer(member);
          let _reason = utils.isEqual(member.id, _member.id) ? reason : common.getFinishReason(member, false);
          if (!utils.isEqual(member.status, CALL_STATUS.DISCONNECTED)) {
            emitQuitEvent({
              reason: _reason,
              member
            });
          }
        });
        updateMember(_member, {
          status: CALL_STATUS.DISCONNECTED,
          reason
        });
        client.$emitter.emit(SIGNAL_NAME.RTC_ROOM_EVENT, {
          roomEventType: ROOM_EVENT_TYPE.DESTROY,
          room: {
            roomId: callInfo.callId
          }
        });
      },
      onclose: event => {
        let {
          target: {
            member,
            quitReason,
            operator
          }
        } = event;
        let currentUser = client.getCurrentUser();
        let isSelfHangup = utils.isEqual(operator.id, member.id);
        let _member = getMember(member);
        let reason = common.getFinishReason(_member, isSelfHangup);

        // ping 超时强制转换为网络异常
        if (utils.isEqual(quitReason, CALL_SERVER_QUIT_REASON.PING_TIMEOUT)) {
          reason = CALL_FINISHED_REASON.NETWORK_ERROR;
        }
        updateMember(_member, {
          status: CALL_STATUS.DISCONNECTED,
          reason
        });
        emitQuitEvent({
          reason,
          member: _member
        });

        // 当前用户退出，更新 CallSession 中的状态和退出房间
        let willQuitRtc = utils.isEqual(currentUser.id, member.id);
        console.log('[call-sdk][hangup]', {
          step: 'session-onclose',
          roomId: callInfo.callId,
          mode: callInfo.isMultiCall ? 'multi' : '1v1',
          mediaType: callInfo.mediaType,
          currentUserId: currentUser.id,
          closeMemberId: member.id,
          operatorId: operator.id,
          willQuitRtc,
          reason,
          streamsNote: willQuitRtc ? 'local-quitRoom' : 'remote-member-only-no-local-quitRoom'
        });
        if (willQuitRtc) {
          stopPing();
          rtcEngine.quitRoom({
            roomId: callInfo.callId
          });
        }
      },
      ondestroy: event => {
        let {
          resolve,
          reject
        } = event;
        let roomId = callInfo.callId;
        console.log('[call-sdk][hangup]', {
          step: 'session-ondestroy',
          roomId,
          mode: callInfo.isMultiCall ? 'multi' : '1v1',
          mediaType: callInfo.mediaType,
          rtcAction: 'stopPing+quitRoom-fallback'
        });
        stopPing();
        rtcEngine.quitRoom({
          roomId
        });
        utils.extend(callInfo, {
          callStatus: machine.getState(),
          members: []
        });
        stopMembersTimer();
        return resolve(callInfo);
      }
    }
  });
  /*
    let options = {
      memberId: '呼叫的对方 Id',
      isEnableCamera: false,
      isMuteMicrophone: false,
      ext: ''
    };
  */
  let startSingleCall = options => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(client, options, FUNC_PARAM_CHECKER.START_SIGNLE_CALL);
      if (!utils.isEmpty(error)) {
        return reject(error);
      }
      let {
        memberId
      } = options;
      options = utils.extend(options, {
        roomType: ROOM_TYPE.ONE_ONE,
        memberIds: [memberId]
      });
      let _options = {
        mediaType: MEDIA_TYPE.VIDEO,
        isEnableCamera: true,
        isMuteMicrophone: false
      };
      _options = utils.extend(_options, options);
      return machine.caller({
        options: _options
      }).then(resolve, reject);
    });
  };
  function startPing() {
    timer.resume(() => {
      client.pingRTC({
        id: callInfo.callId
      }).catch(() => {
        stopPing();
        if (!utils.isEqual(machine.getState(), CALL_STATUS.DISCONNECTED)) {
          machine.hangup({
            reason: CALL_SERVER_QUIT_REASON.PING_TIMEOUT
          });
        }
      });
    });
  }
  function stopPing() {
    timer.pause();
  }
  let startMultiCall = options => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(client, options, FUNC_PARAM_CHECKER.START_MULTI_CALL);
      if (!utils.isEmpty(error)) {
        return reject(error);
      }
      let {
        memberIds
      } = options;
      options = utils.extend(options, {
        roomType: ROOM_TYPE.ONE_MORE,
        memberIds: memberIds
      });
      let _options = {
        mediaType: MEDIA_TYPE.VIDEO,
        isEnableCamera: true,
        isMuteMicrophone: false
      };
      _options = utils.extend(_options, options);
      return machine.caller({
        options: _options
      }).then(resolve, reject);
    });
  };
  /* 
  let view = {
    userId: '',
    videoElemnt: HTMLVideoElement
  };
  */
  let setVideoView = view => {
    return rtcEngine.setVideoView(view);
  };
  // 同意邀请
  let accept = (options = {}) => {
    let _options = {
      mediaType: callInfo.mediaType,
      isEnableCamera: utils.isEqual(callInfo.mediaType, MEDIA_TYPE.VIDEO),
      isMuteMicrophone: false,
      createVideoTrack: utils.isEqual(callInfo.mediaType, MEDIA_TYPE.VIDEO)
    };
    options = utils.extend(_options, options);
    return machine.accept({
      options
    });
  };

  // 当前用户主动挂断
  let hangup = () => {
    return machine.hangup({});
  };

  /*
    当前用户邀请用户
    let options = { memberIds: ['memberId'], isEnableCamera: true };
  */
  let inviteUsers = options => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(client, options, FUNC_PARAM_CHECKER.INVITE_USERS);
      if (!utils.isEmpty(error)) {
        return reject(error);
      }
      let {
        memberIds
      } = options;
      options = utils.extend(options, {
        roomType: ROOM_TYPE.ONE_MORE,
        memberIds: memberIds
      });
      let _options = {
        mediaType: callInfo.mediaType,
        isEnableCamera: utils.isEqual(callInfo.mediaType, MEDIA_TYPE.VIDEO)
      };
      _options = utils.extend(_options, options);
      return machine.invite({
        options: _options
      }).then(resolve, reject);
    });
  };
  let muteMicrophone = isEnable => {
    let user = client.getCurrentUser();
    let isMicrophoneEnabled = !isEnable;
    updateMember(user, {
      micEnable: isMicrophoneEnabled
    });
    sessionEmitter.emit(SIGNAL_NAME.RTC_MICROPHONE_CHANGED, {
      target: {
        callId: callInfo.callId,
        member: {
          id: user.id
        },
        isEnable: isMicrophoneEnabled
      }
    });
    if (utils.isFunction(client.updateRTCState)) {
      client.updateRTCState({
        roomId: callInfo.callId,
        memberId: user.id,
        state: machine.getState(),
        micEnable: isMicrophoneEnabled
      }).catch(utils.noop);
    }
    return rtcEngine.muteMicrophone(isEnable);
  };
  let muteCamera = isEnable => {
    let user = client.getCurrentUser();
    let isCameraEnabled = !isEnable;
    updateMember(user, {
      cameraEnable: isCameraEnabled
    });
    sessionEmitter.emit(SIGNAL_NAME.RTC_CAMERA_CHANGED, {
      target: {
        callId: callInfo.callId,
        member: {
          id: user.id
        },
        isEnable: isCameraEnabled
      }
    });
    if (utils.isFunction(client.updateRTCState)) {
      client.updateRTCState({
        roomId: callInfo.callId,
        memberId: user.id,
        state: machine.getState(),
        cameraEnable: isCameraEnabled
      }).catch(utils.noop);
    }
    return rtcEngine.muteCamera(isEnable);
  };
  let muteSpeaker = isEnable => {
    return rtcEngine.muteSpeaker(isEnable);
  };
  function updateMember(user, info) {
    let {
      members
    } = callInfo;
    members = members || [];
    let isExists = false;
    callInfo.members = members.map(member => {
      if (utils.isEqual(member.id, user.id)) {
        isExists = true;
        member = utils.extend(member, info);
      }
      return member;
    });
    if (!isExists) {
      callInfo.members.push(utils.extend({
        id: user.id
      }, info));
    }
  }
  function getMember(member) {
    let {
      members
    } = callInfo;
    members = members || [];
    let index = utils.find(members, _member => {
      return utils.isEqual(member.id, _member.id);
    });
    return members[index];
  }
  async function joinRTCRoom({
    auth,
    options
  }) {
    let user = client.getCurrentUser();
    let {
      callId
    } = callInfo;
    let {
      isEnableCamera,
      isMuteMicrophone
    } = getMemberMediaState(options);
    updateMember(user, {
      cameraEnable: isEnableCamera,
      micEnable: !isMuteMicrophone
    });
    options = utils.extend({}, options, {
      createVideoTrack: shouldCreateVideoTrack(options)
    });
    let result = await rtcEngine.joinRoom({
      roomId: callId,
      auth,
      userId: user.id
    }, options);
    return result;
  }
  function updateMembers(members = []) {
    utils.forEach(members, member => {
      updateMember(member, member);
    });
  }
  function emitQuitEvent({
    reason,
    member
  }) {
    let {
      callId
    } = callInfo;
    sessionEmitter.emit(SIGNAL_NAME.RTC_MEMBER_QUIT, {
      target: {
        callId,
        member,
        reason
      }
    });
  }
  function startMembersTimer({
    callId,
    inviter,
    members
  }) {
    utils.forEach(members, member => {
      // members 里包含发起方，发起方自己不计时；接收方收到的 members 中包好 inviter，invter 已在房间中，不计时
      if (utils.isEqual(inviter.id, member.id)) {
        return;
      }
      if (utils.isEqual(member.status, CALL_STATUS.CONNECTED)) {
        return;
      }
      let alarm = Alarm();
      alarm.start({
        data: member
      }, e => {
        e.data.isTimeout = true;
        let event = {
          roomId: callId,
          eventType: INVITE_TYPE.HANGUP,
          user: e.data,
          members: [e.data]
        };
        client.$emitter.emit(SIGNAL_NAME.RTC_INVITE_EVENT, event);
      });
      member = utils.extend(member, {
        alarm
      });
    });
  }
  function stopMembersTimer() {
    let {
      members
    } = callInfo;
    utils.forEach(members, member => {
      stopMemberTimer(member);
    });
  }
  function stopMemberTimer(member) {
    let {
      members
    } = callInfo;
    let index = utils.find(members, _member => {
      return utils.isEqual(_member.id, member.id);
    });
    let _member = members[index] || {};
    let {
      alarm
    } = _member;
    if (alarm) {
      alarm.clear();
      delete _member.alarm;
    }
  }
  function isConnected() {
    return utils.isEqual(callInfo.callStatus, CALL_STATUS.CONNECTED);
  }
  function getMediaType(isEnableCamera) {
    return isEnableCamera ? MEDIA_TYPE.VIDEO : MEDIA_TYPE.AUDIO;
  }
  callInfo = utils.extend(callInfo, {
    startSingleCall,
    startMultiCall,
    accept,
    hangup,
    muteCamera,
    muteMicrophone,
    muteSpeaker,
    inviteUsers,
    setVideoView,
    _getMember: getMember,
    _updateMembers: updateMembers,
    _isConnected: isConnected,
    _machine: machine
  });
  return callInfo;
}

function Emitter () {
  /*
  EmitterEvents = {
    name: [event1, event2, ...]
  }
  */
  let EmitterEvents = {};
  let EmitterOnceEvent = {};
  let on = (name, event) => {
    let events = EmitterEvents[name] || [];
    events.push(event);
    let eventObj = {};
    eventObj[name] = events;
    utils.extend(EmitterEvents, eventObj);
  };
  let once = (name, event) => {
    EmitterOnceEvent[name] = event;
  };
  let off = name => {
    delete EmitterEvents[name];
    delete EmitterOnceEvent[name];
  };
  let emit = (name, data) => {
    let events = EmitterEvents[name] || [];
    data = utils.isArray(data) ? data : [data];
    utils.forEach(events, event => {
      event(...data);
    });
    let event = EmitterOnceEvent[name] || utils.noop;
    event(...data);
  };
  let clear = () => {
    utils.forEach(EmitterEvents, (event, name) => {
      delete EmitterEvents[name];
    });
  };
  return {
    on,
    off,
    emit,
    clear,
    once
  };
}

function Zego ({
  engine: zg,
  emitter: sessionEmitter
}) {
  let UPDATE_TYPE = {
    DEL: 'DELETE',
    ADD: 'ADD'
  };
  let videoViews = [];
  let localStreamId = '';
  let localStream;
  let localTrackState = {
    audio: true,
    video: false
  };
  let remoteStreams = {};
  let remoteViews = {};
  let remoteTrackStates = {};
  function getStreamId(roomId, userId) {
    return `${roomId}+++${userId}`;
  }
  function getJoinedRoomId() {
    if (utils.isEmpty(localStreamId)) {
      return '';
    }
    return (localStreamId.split('+++') || [])[0] || '';
  }
  function getUserIdByStreamId(streamID = '') {
    return (streamID.split('+++') || [])[1] || '';
  }
  function getMediaStream(stream) {
    if (!stream) {
      return null;
    }
    if (utils.isFunction(stream.getMediaStream)) {
      return stream.getMediaStream();
    }
    return stream.mediaStream || stream.stream || stream;
  }
  function getRemoteTrackEnabled(streamID, kind) {
    let remoteStream = remoteStreams[streamID];
    let mediaStream = getMediaStream(remoteStream);
    if (!mediaStream) {
      return null;
    }
    let getter = kind === 'audio' ? mediaStream.getAudioTracks : mediaStream.getVideoTracks;
    if (!utils.isFunction(getter)) {
      return null;
    }
    let track = (getter.call(mediaStream) || [])[0];
    if (!track) {
      return null;
    }
    return !track.muted;
  }
  function shouldCreateVideoTrack(options = {}) {
    if (!utils.isUndefined(options.createVideoTrack)) {
      return !!options.createVideoTrack;
    }
    if (!utils.isUndefined(options.allowVideoToggle)) {
      return !!options.allowVideoToggle;
    }
    return utils.isEqual(options.mediaType, MEDIA_TYPE.VIDEO);
  }
  function emitRemoteTrackState(streamID, userId, kind, isEnable) {
    let roomId = getJoinedRoomId() || (streamID.split('+++') || [])[0] || '';
    if (utils.isEmpty(roomId) || utils.isEmpty(userId)) {
      return;
    }
    let eventName = kind === 'audio' ? SIGNAL_NAME.RTC_MICROPHONE_CHANGED : SIGNAL_NAME.RTC_CAMERA_CHANGED;
    console.log('[call-sdk][track-state]', {
      roomId,
      streamID,
      userId,
      kind,
      isEnable,
      eventName
    });
    sessionEmitter.emit(eventName, {
      target: {
        callId: roomId,
        member: {
          id: userId
        },
        isEnable
      }
    });
  }
  function bindRemoteTrackEvents(streamID, userId, remoteStream) {
    let mediaStream = getMediaStream(remoteStream);
    if (!mediaStream) {
      return;
    }
    let bindTrack = kind => {
      let getter = kind === 'audio' ? mediaStream.getAudioTracks : mediaStream.getVideoTracks;
      if (!utils.isFunction(getter)) {
        return;
      }
      let track = (getter.call(mediaStream) || [])[0];
      if (!track) {
        return;
      }
      let stateKey = `${streamID}_${kind}`;
      let updateState = isEnable => {
        if (remoteTrackStates[stateKey] === isEnable) {
          return;
        }
        remoteTrackStates[stateKey] = isEnable;
        console.log('[call-sdk][track-update]', {
          streamID,
          userId,
          kind,
          isEnable,
          muted: track.muted,
          readyState: track.readyState
        });
        emitRemoteTrackState(streamID, userId, kind, isEnable);
      };
      updateState(!track.muted);
      track.onmute = () => updateState(false);
      track.onunmute = () => updateState(true);
      track.onended = () => updateState(false);
    };
    bindTrack('video');
    bindTrack('audio');
  }
  async function playRemoteStream(streamID, view) {
    if (utils.isEmpty(view) || !view.videoElement) {
      return;
    }
    let remoteView = remoteViews[streamID];
    if (remoteView) {
      return remoteView.play(view.videoElement);
    }
    try {
      let remoteStream = await zg.startPlayingStream(streamID);
      remoteStreams[streamID] = remoteStream;
      console.log('[call-sdk][play-remote-stream]', {
        streamID,
        userId: view.userId || getUserIdByStreamId(streamID)
      });
      bindRemoteTrackEvents(streamID, view.userId || getUserIdByStreamId(streamID), remoteStream);
      remoteView = zg.createRemoteStreamView(remoteStream);
      remoteViews[streamID] = remoteView;
      remoteView.play(view.videoElement);
    } catch (error) {
      console.log('playRemoteStream failed', streamID, error);
    }
  }
  function syncViewPlayback(view) {
    if (utils.isEmpty(view) || !view.videoElement) {
      return;
    }
    if (!utils.isEmpty(localStreamId) && utils.isInclude(localStreamId, view.userId) && localStream) {
      return localStream.playVideo(view.videoElement, {
        enableAutoplayDialog: true
      });
    }
    let roomId = getJoinedRoomId();
    if (utils.isEmpty(roomId)) {
      return;
    }
    let streamID = getStreamId(roomId, view.userId);
    if (utils.isEqual(streamID, localStreamId)) {
      return;
    }
    playRemoteStream(streamID, view);
  }
  function syncLocalViewPlayback() {
    if (!localStream || utils.isEmpty(localStreamId)) {
      return;
    }
    utils.forEach(videoViews, view => {
      if (!view || !view.videoElement) {
        return;
      }
      if (utils.isInclude(localStreamId, view.userId)) {
        localStream.playVideo(view.videoElement, {
          enableAutoplayDialog: true
        });
      }
    });
  }
  function hasLocalTrack(kind) {
    let mediaStream = getLocalMediaStream();
    if (!mediaStream) {
      return false;
    }
    let getter = kind === 'audio' ? mediaStream.getAudioTracks : mediaStream.getVideoTracks;
    if (!utils.isFunction(getter)) {
      return false;
    }
    return (getter.call(mediaStream) || []).length > 0;
  }
  function applyLocalVideoState(isEnable) {
    if (!localStream) {
      return;
    }
    zg.mutePublishStreamVideo(localStream, !isEnable);
    zg.enableVideoCaptureDevice(localStream, isEnable);
    setLocalTrackEnabled('video', isEnable);
    localTrackState.video = isEnable;
  }
  async function recreateLocalStreamWithVideo() {
    if (utils.isEmpty(localStreamId)) {
      return;
    }
    let shouldCreateAudioTrack = hasLocalTrack('audio') || localTrackState.audio;
    let nextStream = await zg.createZegoStream({
      camera: {
        video: true,
        audio: shouldCreateAudioTrack
      }
    });
    zg.stopPublishingStream(localStreamId);
    if (localStream) {
      zg.destroyStream(localStream);
    }
    localStream = nextStream;
    zg.startPublishingStream(localStreamId, localStream);
    syncLocalViewPlayback();
    zg.muteMicrophone(!localTrackState.audio);
    setLocalTrackEnabled('audio', localTrackState.audio);
  }
  zg.on('roomStateChanged', async (roomID, reason, errorCode, extendedData) => {
  });
  zg.on('remoteCameraStatusUpdate', (streamID, status) => {
    let userId = getUserIdByStreamId(streamID);
    let isEnable = getRemoteTrackEnabled(streamID, 'video');
    console.log('[call-sdk][zego-remote-camera-status]', {
      streamID,
      userId,
      status,
      isEnable
    });
    if (!utils.isNull(isEnable) && !utils.isUndefined(isEnable)) {
      emitRemoteTrackState(streamID, userId, 'video', isEnable);
    }
  });
  zg.on('remoteMicStatusUpdate', (streamID, status) => {
    let userId = getUserIdByStreamId(streamID);
    let isEnable = getRemoteTrackEnabled(streamID, 'audio');
    console.log('[call-sdk][zego-remote-mic-status]', {
      streamID,
      userId,
      status,
      isEnable
    });
    if (!utils.isNull(isEnable) && !utils.isUndefined(isEnable)) {
      emitRemoteTrackState(streamID, userId, 'audio', isEnable);
    }
  });
  zg.on('roomUserUpdate', (roomId, updateType, userList) => {});
  zg.on('roomStreamUpdate', async (roomId, updateType, streamList, extendedData) => {
    if (utils.isEqual(updateType, UPDATE_TYPE.ADD)) {
      utils.forEach(streamList, async stream => {
        let streamID = stream.streamID;
        let view = videoViews.find(view => {
          return utils.isInclude(streamID, view.userId);
        }) || {};
        if (utils.isEmpty(view)) {
          return console.log('roomStreamUpdate not match views', streamID);
        }
        playRemoteStream(streamID, view);
      });
    }
    if (utils.isEqual(updateType, UPDATE_TYPE.DEL)) {
      utils.forEach(streamList, async stream => {
        let streamID = stream.streamID;
        zg.stopPlayingStream(streamID);
        delete remoteStreams[streamID];
        delete remoteViews[streamID];
        delete remoteTrackStates[`${streamID}_audio`];
        delete remoteTrackStates[`${streamID}_video`];
        let index = utils.find(videoViews, view => {
          return utils.isInclude(streamID, view.userId);
        });
        if (index > -1) {
          videoViews.splice(index, 1);
        }
      });
    }
  });
  /* 
  let view = {
    userId: '',
    videoElemnt: HTMLVideoElement
  };
  */
  let setVideoView = option => {
    let views = utils.isArray(option) ? option : [option];
    utils.forEach(views, view => {
      let index = utils.find(videoViews, _view => {
        return utils.isEqual(_view.userId, view.userId);
      });
      if (index > -1) {
        videoViews.splice(index, 1, view);
      } else {
        videoViews.push(view);
      }
      syncViewPlayback(view);
    });
  };
  let removeVideoView = view => {
    let index = utils.find(videoViews, _view => {
      return utils.isEqual(_view.userId, view.userId);
    });
    if (index > -1) {
      videoViews.splice(index, 1);
    }
  };
  let joinRoom = (room, options = {}) => {
    let {
      auth,
      roomId,
      userId
    } = room;
    let {
      isEnableCamera,
      isMuteMicrophone,
      mediaType
    } = options;
    let {
      zegoAuth
    } = auth;
    return utils.deferred(async resolve => {
      let result = await zg.checkSystemRequirements("camera");
      if (!utils.isEmpty(result.errInfo)) {
        return resolve({
          ...ErrorType.RTC_DEVICE_NOT_ALLOWED,
          isJoined: false
        });
      }
      zg.loginRoom(roomId, zegoAuth.token, {
        userID: userId,
        userName: userId
      }, {
        userUpdate: true
      }).then(async isJoined => {
        if (isJoined) {
          let streamID = `${roomId}+++${userId}`;
          let needVideoTrack = shouldCreateVideoTrack(options);
          localTrackState.audio = !isMuteMicrophone;
          localTrackState.video = needVideoTrack && isEnableCamera;
          localStream = await zg.createZegoStream({
            camera: {
              video: needVideoTrack,
              audio: !isMuteMicrophone
            }
          });
          let view = videoViews.find(view => {
            return utils.isInclude(streamID, view.userId);
          });
          if (view && isEnableCamera) {
            localStream.playVideo(view.videoElement, {
              enableAutoplayDialog: true
            });
          }
          zg.startPublishingStream(streamID, localStream);
          localStreamId = streamID;
          if (needVideoTrack && !isEnableCamera) {
            console.log('[call-sdk][mute-camera]', {
              streamID,
              shouldCreateVideoTrack: needVideoTrack,
              isEnableCamera
            });
            zg.mutePublishStreamVideo(localStream, true);
            zg.enableVideoCaptureDevice(localStream, false);
            setLocalTrackEnabled('video', false);
          }
          return resolve({
            isJoined
          });
        }
        resolve({
          ...ErrorType.RTC_JOIN_FAILED,
          isJoined
        });
      });
    });
  };
  let quitRoom = room => {
    let roomId = room.id || room.roomId;
    let currentLocalStreamId = localStreamId;
    let currentLocalStream = localStream;
    let remoteStreamIds = Object.keys(remoteStreams || {});
    let mediaStream = getMediaStream(currentLocalStream);
    let localAudioTracks = 0;
    let localVideoTracks = 0;
    if (mediaStream) {
      if (utils.isFunction(mediaStream.getAudioTracks)) {
        localAudioTracks = mediaStream.getAudioTracks().length;
      }
      if (utils.isFunction(mediaStream.getVideoTracks)) {
        localVideoTracks = mediaStream.getVideoTracks().length;
      }
    }
    console.log('[call-sdk][hangup]', {
      step: 'zego-quitRoom-before',
      roomId,
      localStreamId: currentLocalStreamId || null,
      hasLocalStream: !!currentLocalStream,
      localTrackState: {
        ...localTrackState
      },
      localAudioTracks,
      localVideoTracks,
      remoteStreamCount: remoteStreamIds.length,
      remoteStreamIds,
      videoViewCount: videoViews.length
    });
    videoViews = [];
    remoteStreams = {};
    remoteViews = {};
    remoteTrackStates = {};
    if (currentLocalStreamId) {
      zg.stopPublishingStream(currentLocalStreamId);
    }
    if (currentLocalStream) {
      zg.destroyStream(currentLocalStream);
    }
    localStreamId = '';
    localStream = null;
    localTrackState = {
      audio: true,
      video: false
    };
    if (roomId) {
      zg.logoutRoom(roomId);
    }
    console.log('[call-sdk][hangup]', {
      step: 'zego-quitRoom-after',
      roomId,
      didStopPublish: !!currentLocalStreamId,
      didDestroyLocal: !!currentLocalStream,
      didLogout: !!roomId
    });
  };
  let muteMicrophone = (isMute = true) => {
    zg.muteMicrophone(isMute);
    setLocalTrackEnabled('audio', !isMute);
    sessionEmitter.emit(SIGNAL_NAME.RTC_MICROPHONE_CHANGED, {
      target: {
        isEnable: !isMute
      }
    });
  };
  let muteCamera = async (isMute = true) => {
    let isEnable = !isMute;
    try {
      if (isEnable && !hasLocalTrack('video')) {
        await recreateLocalStreamWithVideo();
      }
      applyLocalVideoState(isEnable);
      if (isEnable) {
        syncLocalViewPlayback();
      }
    } catch (error) {
      console.log('[call-sdk][mute-camera-failed]', {
        isMute,
        error
      });
      return;
    }
    sessionEmitter.emit(SIGNAL_NAME.RTC_CAMERA_CHANGED, {
      target: {
        isEnable
      }
    });
  };
  let muteSpeaker = (isMute = true) => {
    zg.muteAllPlayAudioStreams(isMute);
  };
  function getLocalMediaStream() {
    if (!localStream) {
      return null;
    }
    if (utils.isFunction(localStream.getMediaStream)) {
      return localStream.getMediaStream();
    }
    return localStream.mediaStream || localStream.stream || null;
  }
  function setLocalTrackEnabled(kind, isEnable) {
    let mediaStream = getLocalMediaStream();
    if (!mediaStream) {
      return;
    }
    let getTracks = kind === 'audio' ? mediaStream.getAudioTracks : mediaStream.getVideoTracks;
    if (!utils.isFunction(getTracks)) {
      return;
    }
    utils.forEach(getTracks.call(mediaStream), track => {
      track.enabled = isEnable;
    });
  }
  return {
    joinRoom,
    quitRoom,
    setVideoView,
    removeVideoView,
    muteCamera,
    muteMicrophone,
    muteSpeaker
  };
}

function RTCEngine (option) {
  let {
    engine
  } = option;
  let _rtc = {};
  if (engine.zegoWebRTC) {
    _rtc = Zego(option);
  }
  // More RTC Engine
  return _rtc;
}

function Factory ({
  client,
  engine
}) {
  let emitter = Emitter();
  let sessionEmitter = Emitter();
  let rtcEngine = RTCEngine({
    engine,
    emitter: sessionEmitter
  });
  let callSessions = [];
  let getSessionIndex = origin => {
    return utils.find(callSessions, callSession => {
      return utils.isEqual(origin.callId, callSession.callId);
    });
  };
  function notifyJoined(content) {
    sessionEmitter.emit(SIGNAL_NAME.RTC_MEMBER_JOINED, {
      target: content
    });
  }
  function notifyQuit(content) {
    let {
      callId,
      member,
      reason,
      operator
    } = content;
    let session = getSession({
      callId
    });
    if (!session._machine) {
      console.log('[call-sdk][hangup]', {
        step: 'notifyQuit-skip',
        callId,
        why: 'no-session-machine',
        memberId: member && member.id,
        operatorId: operator && operator.id
      });
      return;
    }
    let _member = session._getMember(member);
    let sessionMemberIds = utils.map(session.members || [], m => m && m.id);
    if (utils.isUndefined(_member) || utils.isNull(_member)) {
      console.log('[call-sdk][hangup]', {
        step: 'notifyQuit-warn',
        callId,
        why: 'member-not-in-session',
        lookedUpId: member && member.id,
        operatorId: operator && operator.id,
        sessionMemberIds,
        isMultiCall: !!session.isMultiCall
      });
      return;
    }
    utils.extend(_member, {
      isTimeout: member.isTimeout
    });
    let alreadyOff = utils.isEqual(_member.status, CALL_STATUS.DISCONNECTED);
    console.log('[call-sdk][hangup]', {
      step: 'notifyQuit',
      callId,
      mode: session.isMultiCall ? 'multi' : '1v1',
      memberId: member && member.id,
      operatorId: operator && operator.id,
      quitReason: reason,
      alreadyDisconnected: alreadyOff,
      sessionMemberIds
    });
    if (!alreadyOff) {
      session._machine.close({
        member,
        quitReason: reason,
        operator
      });
    }
  }
  function syncMultiCallState(session, members = []) {
    if (!session) {
      return;
    }
    let sessionMembers = [].concat(session.members || [], members || []);
    let activeMemberIds = {};
    utils.forEach(sessionMembers, member => {
      if (!member || !member.id) {
        return;
      }
      if (utils.isEqual(member.status, CALL_STATUS.DISCONNECTED)) {
        return;
      }
      activeMemberIds[member.id] = true;
    });
    if (Object.keys(activeMemberIds).length > 2) {
      session.isMultiCall = true;
    }
  }

  // 监听邀请状态变化
  client.$emitter.on(SIGNAL_NAME.RTC_INVITE_EVENT, event => {
    let inviteEvent = getInviteEvent(event);
    let {
      callId,
      roomType,
      eventType,
      member,
      members,
      existsMembers,
      ext,
      mediaType
    } = inviteEvent;

    // 被其他人邀请通话时触发
    if (utils.isEqual(eventType, INVITE_TYPE.INVITE)) {
      let user = client.getCurrentUser();
      let index = utils.find(members, member => {
        return utils.isEqual(member.id, user.id);
      });
      let isInviteOneself = index > -1;
      let session = getSession({
        callId
      });
      if (!utils.isEmpty(session)) {
        utils.extend(session, {
          mediaType,
          isMultiCall: session.isMultiCall || utils.isEqual(ROOM_TYPE.ONE_MORE, roomType)
        });
        session._machine.memberinvite({
          members
        });
      } else {
        // 本地没有对应的 CallSession 并且不是邀请自己别的端已经在房间里，本端忽略
        if (!isInviteOneself) {
          return;
        }
        session = create({
          callId,
          isMultiCall: utils.isEqual(ROOM_TYPE.ONE_MORE, roomType),
          ext,
          mediaType
        });
        session._machine.callee({
          callId,
          inviter: member,
          members,
          existsMembers,
          ext,
          mediaType
        });
      }
      if (isInviteOneself) {
        emitter.emit(EVENT_NAME.INVITED, {
          target: {
            callId,
            mediaType
          }
        });
      }
    }

    // 邀请成员加入通话，成员同意后触发
    if (utils.isEqual(eventType, INVITE_TYPE.ACCEPT)) {
      let session = getSession({
        callId
      });
      if (session) {
        session._machine.calleraccepted({
          callId,
          member
        });
      }
    }

    // 收到成员挂断通话后触发
    if (utils.isEqual(eventType, INVITE_TYPE.HANGUP)) {
      let session = getSession({
        callId
      });
      let user = client.getCurrentUser();
      let connected = utils.isFunction(session._isConnected) ? session._isConnected() : false;
      let sessionMembers = session.members || [];
      let sessionMemberIds = utils.map(sessionMembers, m => m && m.id);
      console.log('[call-sdk][hangup]', {
        step: 'signaling-recv',
        callId,
        mode: session.isMultiCall ? 'multi' : '1v1',
        isMultiCall: !!session.isMultiCall,
        connected,
        localUserId: user && user.id,
        operatorId: member && member.id,
        isTimeout: !!(member && member.isTimeout),
        mediaType: session.mediaType,
        sessionMemberCount: sessionMembers.length,
        sessionMemberIds
      });

      // 多人通话且未接听的情况下，单个人退出，收到 HANGUP 全部退出。
      if (session.isMultiCall && session._isConnected()) {
        console.log('[call-sdk][hangup]', {
          step: 'signaling-branch',
          callId,
          mode: 'multi',
          action: 'notifyQuit-only',
          detail: 'multi-connected'
        });
        notifyQuit({
          callId,
          member,
          operator: member
        });
      } else if (session.isMultiCall && !utils.isEqual(user.id, member.id)) {
        console.log('[call-sdk][hangup]', {
          step: 'signaling-branch',
          callId,
          mode: 'multi',
          action: 'notifyQuit-only',
          detail: 'multi-not-self-hangup'
        });
        notifyQuit({
          callId,
          member,
          operator: member
        });
      } else {
        // 1v1 挂断 或 多人超时自己挂断后退出后结束通话 
        let {
          isTimeout
        } = member;
        let {
          members = []
        } = session;
        console.log('[call-sdk][hangup]', {
          step: 'signaling-branch',
          callId,
          mode: session.isMultiCall ? 'multi' : '1v1',
          action: 'notifyQuit-all-then-destroy',
          notifyCount: members.length,
          sessionMemberIds
        });
        utils.forEach(members, _member => {
          notifyQuit({
            callId,
            member: {
              ..._member,
              isTimeout
            },
            operator: member
          });
        });
        destroy({
          callId
        });
      }
    }
  });
  client.$emitter.on(SIGNAL_NAME.RTC_FINISHED_1V1_EVENT, notify => {
    common.get1v1Reason(notify);
    // TODO: 对外抛出消息
  });

  // 监听f房间状态变化
  client.$emitter.on(SIGNAL_NAME.RTC_ROOM_EVENT, event => {
    let {
      roomEventType,
      room,
      members,
      reason
    } = event;
    let callId = room.roomId;

    // 多人通话，有人加入房间
    if (utils.isEqual(roomEventType, ROOM_EVENT_TYPE.JOINED)) {
      let session = getSession({
        callId
      });
      if (session._updateMembers) {
        session._updateMembers(members);
      }
      syncMultiCallState(session, members);
      utils.forEach(members, member => {
        notifyJoined({
          callId,
          member
        });
      });
    }

    // 有人退出房间：呼叫超时或者 PING 超时，用户挂断触发 HANGUP 事件
    if (utils.isEqual(roomEventType, ROOM_EVENT_TYPE.QUIT)) {
      let session = getSession({
        callId
      });
      console.log('[call-sdk][hangup]', {
        step: 'room-quit',
        callId,
        mode: session.isMultiCall ? 'multi' : '1v1',
        reason,
        quitMemberIds: utils.map(members || [], m => m && m.id)
      });
      if (session.isMultiCall) {
        utils.forEach(members, member => {
          notifyQuit({
            callId,
            member,
            reason,
            operator: member
          });
        });
      } else {
        utils.forEach(session.members, member => {
          let index = utils.find(members, _member => {
            return utils.isEqual(_member.id, member.id);
          });
          let isQuitMember = index > -1;
          let notify = {
            callId,
            member,
            operator: member
          };
          if (isQuitMember) {
            utils.extend(notify, {
              reason,
              operator: members[index]
            });
          }
          notifyQuit(notify);
        });
        destroy({
          callId
        });
      }
    }

    // 多人通话所有成员退出房间或 1v1 其中一个成员退出房间事触发
    if (utils.isEqual(roomEventType, ROOM_EVENT_TYPE.DESTROY)) {
      console.log('[call-sdk][hangup]', {
        step: 'room-destroy',
        callId
      });
      destroy({
        callId
      });
    }

    // 房间内成员状态变更后触发    
    if (utils.isEqual(roomEventType, ROOM_EVENT_TYPE.STATECHANGED)) {
      let session = getSession({
        callId
      });
      if (session._updateMembers) {
        session._updateMembers(members);
      }
      syncMultiCallState(session, members);
      utils.forEach(members, member => {
        if (!utils.isUndefined(member.cameraEnable)) {
          sessionEmitter.emit(SIGNAL_NAME.RTC_CAMERA_CHANGED, {
            target: {
              callId,
              member,
              isEnable: member.cameraEnable
            }
          });
        }
        if (!utils.isUndefined(member.micEnable)) {
          sessionEmitter.emit(SIGNAL_NAME.RTC_MICROPHONE_CHANGED, {
            target: {
              callId,
              member,
              isEnable: member.micEnable
            }
          });
        }
      });
    }
  });

  // 绑定内部事件
  sessionEmitter.on(SIGNAL_NAME.RTC_CALL_CONNECTED, event => {
    emitter.emit(EVENT_NAME.CALL_CONNECTED, event);
  });
  sessionEmitter.on(SIGNAL_NAME.RTC_CALL_FINISHED, event => {
    emitter.emit(EVENT_NAME.CALL_FINISHED, event);
  });
  sessionEmitter.on(SIGNAL_NAME.RTC_CALL_ERROR, event => {
    emitter.emit(EVENT_NAME.CALL_ERROR, event);
  });
  sessionEmitter.on(SIGNAL_NAME.RTC_MEMBER_JOINED, event => {
    emitter.emit(EVENT_NAME.MEMBER_JOINED, event);
  });
  sessionEmitter.on(SIGNAL_NAME.RTC_MEMBER_QUIT, event => {
    let {
      target: {
        member,
        callId
      }
    } = event;
    rtcEngine.removeVideoView({
      userId: member.id
    });
    emitter.emit(EVENT_NAME.MEMBER_QUIT, event);
  });
  sessionEmitter.on(SIGNAL_NAME.RTC_CAMERA_CHANGED, event => {
    emitter.emit(EVENT_NAME.CAMERA_CHANGED, event);
  });
  sessionEmitter.on(SIGNAL_NAME.RTC_MICROPHONE_CHANGED, event => {
    emitter.emit(EVENT_NAME.MICROPHONE_CHANGED, event);
  });
  function create(option = {}) {
    let {
      callId
    } = option;
    let index = getSessionIndex({
      callId
    });
    let session = callSessions[index];
    if (!session) {
      session = CallSession(option, {
        client,
        rtcEngine,
        emitter: sessionEmitter,
        isNew: true
      });
      callSessions.push(session);
    }
    return session;
  }
  function getExportSession(session) {
    let {
      members,
      isMultiCall,
      callStatus,
      callId,
      mediaType
    } = session;
    return {
      members,
      isMultiCall,
      callStatus,
      callId,
      mediaType
    };
  }
  function getInviteEvent(event = {}) {
    let content = normalizeInviteContent(event.content);
    let target = normalizeInviteContent(event.target);
    let nestedContent = normalizeInviteContent(content.content);
    let nestedTarget = normalizeInviteContent(target.content);
    let payload = utils.extend({}, [nestedContent, nestedTarget, content, target, event]);
    return {
      callId: payload.roomId || payload.callId,
      roomType: payload.roomType,
      eventType: payload.eventType,
      member: payload.user || payload.member || payload.inviter,
      members: payload.members || [],
      existsMembers: payload.existsMembers || [],
      ext: payload.ext || '',
      mediaType: payload.mediaType
    };
  }
  function normalizeInviteContent(content) {
    if (utils.isString(content)) {
      return utils.parse(content);
    }
    return content || {};
  }
  let destroy = (option = {}) => {
    let {
      callId
    } = option;
    let session = getSession({
      callId
    });
    console.log('[call-sdk][hangup]', {
      step: 'destroy-start',
      callId,
      hasMachine: !!session._machine
    });
    if (session._machine) {
      session._machine.destroy().then(_session => {
        utils.extend(session, {
          ..._session
        });
        let result = getExportSession(session);
        console.log('[call-sdk][hangup]', {
          step: 'destroy-done',
          callId,
          callStatus: result.callStatus,
          mediaType: result.mediaType
        });
        sessionEmitter.emit(SIGNAL_NAME.RTC_CALL_FINISHED, result);
        let index = getSessionIndex({
          callId
        });
        if (index > -1) {
          callSessions.splice(index, 1);
        }
      });
    }
  };
  let clear = () => {
    callSessions = [];
  };
  let getSessions = () => {
    return callSessions;
  };
  function getSession(option = {}) {
    let {
      callId
    } = option;
    let index = getSessionIndex({
      callId
    });
    let session = callSessions[index] || {};
    return session;
  }
  return {
    ...emitter,
    create,
    clear,
    getSessions,
    getSession,
    convertMsgReason: common.get1v1Reason
  };
}

let globalFactory = {};
var index = {
  CallEvent: EVENT_NAME,
  CallFinishedReason: CALL_FINISHED_REASON,
  /* 
    let config = {
      // 即构的 RTC SDK 实例
      engine: {},
      // IM 实例对象
      client: {}
    }
  */
  init: config => {
    if (!utils.isEmpty(globalFactory)) {
      return globalFactory;
    }
    globalFactory = Factory(config);
    return globalFactory;
  }
};

export { index as default };
