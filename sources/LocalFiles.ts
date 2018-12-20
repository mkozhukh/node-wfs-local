import * as fs from "fs-extra";
import * as filepath from "path";

import getFileType from "./filetypes";
import {CombinedPolicy, ForceRootPolicy} from "./policy";
import {IDriveConfig, IFsObject, IListConfig, IPolicy, Operation} from "./types";

const isWindows = filepath.sep === "\\";

export default class LocalFiles {
	private policy: IPolicy;
	private _root: string;
	private _config: IDriveConfig;

	constructor(root: string, policy?: IPolicy, config?:IDriveConfig){
		if (!root ||
			(!isWindows && root[0] !== "/") ||
			(isWindows && !/^[A-Z]:\\/i.test(root))){
				// expect full path from the drive root
				// it is necessary to ensure ForceRoot policy
				throw new Error("Invalid root folder");
			}
			
		if (!policy) {
			this.policy = new ForceRootPolicy(root);
		}else {
			this.policy = new CombinedPolicy(
				new ForceRootPolicy(root),
				policy
			);
		}

		this._config = config || {};
		this._root = root;
	}

	async list(path: string, config?: IListConfig) : Promise<IFsObject[]> {
		if (this._config.verbose){
			console.log("List %s", path);
			console.log("with config ", config);
		}

		const fullpath = this.idToPath(path);
		config = config || {};

		if (this.policy.comply(fullpath, Operation.Read)) {
			return this._listFolder(fullpath, path, config, null);
		}
		throw new Error("Access Denied");
	}

	async remove(path: string): Promise<void>{
		if (this._config.verbose){
			console.log("Delete %s", path);
		}

		const fullpath = this.idToPath(path);
		if (this.policy.comply(fullpath, Operation.Write)) {
			return fs.remove(fullpath);
		}

		throw new Error("Access Denied");
	}

	async read(path: string): Promise<fs.ReadStream> {
		if (this._config.verbose){
			console.log("Get content of %s", path);
		}

		const fullpath = this.idToPath(path);
		if (this.policy.comply(fullpath, Operation.Read)) {
			return fs.createReadStream(fullpath);
		}

		throw new Error("Access Denied");
	}

	async write(path: string, data: fs.ReadStream): Promise<string> {
		if (this._config.verbose){
			console.log("Save content to %s", path);
		}

		const fullpath = this.idToPath(path);
		if (this.policy.comply(fullpath, Operation.Write)) {
			const writeStream  = fs.createWriteStream(fullpath);
			const result = data.pipe(writeStream);

			const done : Promise<void> = new Promise((res, rej) => {
				data.on("end", res);
				data.on("error", rej);
			});

			return done.then(() => this.pathToId(fullpath));
		}
		throw new Error("Access Denied");
	}

	async info(id) : Promise<IFsObject> {
		const fullpath = this.idToPath(id);
		if (!this.policy.comply(fullpath, Operation.Read)) {
			throw new Error("Access Denied");
		}

		const stat = await fs.lstat(fullpath);
		const name = filepath.basename(fullpath);
		const type = stat.isDirectory() ? "folder" : getFileType(name);
		const obj : IFsObject = {
			value:name,
			id,
			size:stat.size,
			date:stat.mtime.valueOf()/1000,
			type
		};

		return obj;
	}

	async mkdir(path: string) : Promise<string> {
		if (this._config.verbose){
			console.log("Make folder %s", path);
		}

		const fullpath = this.idToPath(path);
		if (!this.policy.comply(fullpath, Operation.Write)) {
			throw new Error("Access Denied");
		}

		await fs.ensureDir(fullpath);
		return this.pathToId(fullpath);
	}

	async copy(sourceId: string, targetId: string): Promise<string> {
		if (this._config.verbose){
			console.log("Copy %s to %s", sourceId, targetId);
		}

		const source = this.idToPath(sourceId);
		let target = this.idToPath(targetId);

		if (!this.policy.comply(source, Operation.Read) || !this.policy.comply(target, Operation.Write)) {
			throw new Error("Access Denied");
		}

		const et = await this.isFolder(target);
		// file to folder
		if (et) {
			target = filepath.join(target, filepath.basename(source));
		}

		// file to file
		await fs.copy(source, target);
		return this.pathToId(target);
	}

	async exists(source: string): Promise<boolean> {
		source = this.idToPath(source);
		if (this.policy.comply(source, Operation.Read)){
			return fs.pathExists(source);
		}

		throw new Error("Access Denied");
	}

	async move(source: string, target: string): Promise<string> {
		if (this._config.verbose){
			console.log("Move %s to %s", source, target);
		}

		source = this.idToPath(source);
		target = this.idToPath(target);

		if (!this.policy.comply(source, Operation.Write) ||
			!this.policy.comply(target, Operation.Write)) {
			throw new Error("Access Denied");
		}

		const et = await this.isFolder(target);

		// file to folder
		if (et) {
			target = filepath.join(target, filepath.basename(source));
		}

		await fs.move(source, target);
		return this.pathToId(target);
	}

	private async isFolder(path: string): Promise<boolean> {
		try {
			const stat = await fs.lstat(path);
			return stat.isDirectory();
		} catch(e){
			return false;
		}
	}

	private idToPath(id: string): string {
		return filepath.normalize(filepath.join(this._root, id));
	}
	private pathToId(path: string): string {
		const id = path.replace(this._root, "");

		if (isWindows){
				return id.replace(/\\/g, "/");
		}
		return id;
	}

	private async _listFolder(
		path: string,
		prefix: string,
		cfg: IListConfig,
		list: IFsObject[]) : Promise<IFsObject[]> {

		const files = await fs.readdir(path);
		const res = (list && !cfg.nested) ? list : [];

		for (const name of files){
			if (name === ".") {
				continue;
			}
			if (cfg.exclude && cfg.exclude(name)) {
				continue;
			}

			const fullpath = filepath.join(this._root, prefix, name);
			const id = this.pathToId(fullpath);
			const stat = await fs.lstat(fullpath);
			const type = stat.isDirectory() ? "folder" : getFileType(name);
			const obj : IFsObject = { value:name, id, size:stat.size, date:stat.mtime.valueOf()/1000, type };

			if (stat.isDirectory()) {
				if (cfg.subFolders) {
					const next = await this._listFolder(
						filepath.join(path, name),
						filepath.join(prefix, name),
						cfg,
						res
					);
					if (cfg.nested){
						obj.data = next;
					}
				}
			} else {
				if (cfg.skipFiles) {
					continue;
				}
			}

			if (cfg.include && !cfg.include(name)){
				continue;
			}
			res.push(obj);
		}

		// folders first
		// sort files and folders by name
		if (list !== res){
			res.sort((a,b) => {
				if ((a.type === "folder" || b.type === "folder") && a.type !== b.type){
					return a.type === "folder" ? -1 : 1;
				}

				if (a.value !== b.value){
					return a.value.toUpperCase() > b.value.toUpperCase() ? 1 : -1;
				}
				return 0;
			});
		}

		return res;
	}
}