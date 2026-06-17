/** Order status constants (ported from the web app's @/types/orderStatus). */

export const ORDER_STATUS = {
  NORMAL: 0,
  WILL_CALL: 1,
  WEATHER_PERMITTING: 2,
  HOLD: 3,
  COMPLETED: 4,
  WAIT_LIST: 5,
};

export const STATUS_LABELS = {
  [ORDER_STATUS.NORMAL]: 'Normal',
  [ORDER_STATUS.WILL_CALL]: 'Will Call',
  [ORDER_STATUS.WEATHER_PERMITTING]: 'Weather Permitting',
  [ORDER_STATUS.HOLD]: 'Hold',
  [ORDER_STATUS.COMPLETED]: 'Completed',
  [ORDER_STATUS.WAIT_LIST]: 'Wait List',
};

export const PRE_POUR_STATUSES = [
  ORDER_STATUS.NORMAL,
  ORDER_STATUS.WILL_CALL,
  ORDER_STATUS.HOLD,
  ORDER_STATUS.WAIT_LIST,
];

export const IN_PROCESS_STATUSES = [ORDER_STATUS.NORMAL, ORDER_STATUS.HOLD];
