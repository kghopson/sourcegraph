import {rel} from "sourcegraph/app/routePatterns";
import type {Route} from "react-router";

export const integrations = {
	getComponent: (location, callback) => {
		require.ensure([], (require) => {
			callback(null, {
				navContext: null,
				main: require("sourcegraph/home/IntegrationsContainer").default,
			});
		});
	},
};

export const routes: Array<Route> = [
	{
		...integrations,
		path: rel.integrations,
	},
];
