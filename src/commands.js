// Add/Update user	DATA UPDATE USERINFO PIN=123 Name=Alice Privilege=0 Card=123

const commands = {
  set_user: 'C:1:DATA UPDATE USERINFO PIN=123\tName=Alice\tPrivilege=0\tCard=123',
  query_one_user: 'C:5:DATA QUERY USERINFO PIN=1',
  restart_device: 'C:5:CONTROL DEVICE 03000000',
  all_users: 'C:4:DATA QUERY USERINFO',
  clear_attendance: 'C:5:DATA DELETE ATTLOG',
  attendance_range:
    'C:5:DATA QUERY ATTLOG StartTime=2025-01-01 00:00:00 EndTime=2025-01-02 23:59:59',
  delete_user: 'C:5:DATA DELETE USERINFO PIN=6',
};
module.exports = commands;
