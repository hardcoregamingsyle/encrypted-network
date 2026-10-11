// The old top bar is gone. Navigation is now SideNav (wide screens) and BottomTabs (phones).
// This file keeps the old import path working.
import SideNav from './SideNav.jsx';

export default SideNav;
export { SideNav as Nav };
export { NAV_ITEMS as NAV_LINKS } from './navConfig.js';
