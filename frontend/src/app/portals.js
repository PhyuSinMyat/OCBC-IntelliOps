import { ArrowLeftRight, Bot, Building2, ChartNoAxesCombined, FileClock, FileText, LayoutDashboard, Settings, TriangleAlert, UserCheck, Workflow } from 'lucide-react';

export const portals = [
  { id: 'intelliops', label: 'IntelliOps', description: 'Operations intelligence', icon: Bot, home: '/intelliops/overview', sections: [
    { label: 'Workspace', items: [['overview', 'Overview', LayoutDashboard], ['exceptions', 'Exception Center', TriangleAlert], ['investigation', 'AI Investigation', Bot], ['workflows', 'Resolution Workflows', Workflow], ['approvals', 'Approval Center', UserCheck], ['audit', 'Audit Trail', FileClock]] },
    { label: 'Management', items: [['analytics', 'Analytics', ChartNoAxesCombined], ['settings', 'Settings', Settings]] },
  ] },
  { id: 'payments', label: 'Payment Processing', description: 'Transaction operations', icon: ArrowLeftRight, home: '/payments/transactions', sections: [{ label: 'Workspace', items: [['transactions', 'Transactions', ArrowLeftRight]] }] },
  { id: 'core-banking', label: 'Core Banking / Ledger', description: 'Accounting records', icon: Building2, home: '/core-banking/accounts', sections: [{ label: 'Workspace', items: [['accounts', 'Accounts', Building2], ['journals', 'Ledger Journals', FileText]] }] },
];
