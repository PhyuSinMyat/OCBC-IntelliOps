import { ArrowLeftRight, Bot, Building2, ChartNoAxesCombined, ClipboardList, FileClock, FileText, LayoutDashboard, MessageSquare, Scale, Settings, TriangleAlert, UserCheck, Workflow } from 'lucide-react';

export const portals = [
  { id: 'intelliops', label: 'IntelliOps', description: 'Operations intelligence', icon: Bot, home: '/intelliops/overview', sections: [
    { label: 'Workspace', items: [['overview', 'Overview', LayoutDashboard], ['exceptions', 'Exception Center', TriangleAlert], ['investigation', 'AI Investigation', Bot], { path: 'workflows', label: 'Resolution Workspace', icon: Workflow, children: [['workflows/plans', 'Resolution Plans', ClipboardList], ['workflows/communication', 'Customer Communication', MessageSquare], ['workflows/policy', 'Policy Assessment', Scale]] }, ['approvals', 'Approval Center', UserCheck], ['audit', 'Audit Trail', FileClock]] },
    { label: 'Management', hidden: true, items: [['analytics', 'Analytics', ChartNoAxesCombined], ['settings', 'Settings', Settings]] },
  ] },
  { id: 'payments', label: 'Payment Processing', description: 'Transaction operations', icon: ArrowLeftRight, home: '/payments/transactions', sections: [{ label: 'Workspace', items: [['transactions', 'Transactions', ArrowLeftRight]] }] },
  { id: 'core-banking', label: 'Core Banking / Ledger', description: 'Accounting records', icon: Building2, home: '/core-banking/accounts', sections: [{ label: 'Workspace', items: [['accounts', 'Accounts', Building2], ['journals', 'Ledger Journals', FileText]] }] },
];
