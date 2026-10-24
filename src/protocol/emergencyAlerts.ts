import { MessagePriority } from '../types/message';

export interface EmergencyPreset {
  id: string;
  title: string;
  payload: string;
  priority: MessagePriority;
  icon: string;
  color: string;
}

export const USER_FRIENDLY_PRESETS: EmergencyPreset[] = [
  {
    id: 'sos_help',
    title: 'Need Help',
    payload: 'EMERGENCY: I need immediate help at my current location!',
    priority: 'CRITICAL_SOS',
    icon: '',
    color: '#EF4444',
  },
  {
    id: 'safe',
    title: 'I am Safe',
    payload: 'Status update: I am safe and unharmed.',
    priority: 'NORMAL',
    icon: '',
    color: '#10B981',
  },
  {
    id: 'medical',
    title: 'Medical Help',
    payload: 'URGENT: Someone here is injured and needs medical assistance.',
    priority: 'URGENT',
    icon: '',
    color: '#F59E0B',
  },
  {
    id: 'supplies',
    title: 'Need Water/Food',
    payload: 'Request: We need drinking water and basic food supplies.',
    priority: 'NORMAL',
    icon: '',
    color: '#0EA5E9',
  },
  {
    id: 'where_safe',
    title: 'Safe Zone?',
    payload: 'Question: Where is the nearest safe shelter or assembly area?',
    priority: 'NORMAL',
    icon: '',
    color: '#8B5CF6',
  },
];

export const EMERGENCY_PRESETS = USER_FRIENDLY_PRESETS;

